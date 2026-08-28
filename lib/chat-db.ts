// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts.

import Dexie from "dexie";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

function normalizeGroupName(value: string | undefined): string {
    return (value || "")
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLocaleLowerCase();
}

/**
 * A restored backup can contain several snapshots of the same group with
 * different session ids.  A group name alone is too weak (two unrelated
 * groups may share it), so legacy groups are matched by normalized name and
 * the unordered member set.
 */
export function getGroupSessionIdentity(session: ChatSession): string | null {
    if (!session.isGroup) return null;
    const name = normalizeGroupName(session.groupName);
    const participants = Array.from(new Set(
        (session.participantIds || []).map((id) => id.trim()).filter(Boolean),
    )).sort();
    if (!name || participants.length === 0) return null;
    return `${name}\u0000${participants.join("\u0000")}`;
}

function sessionUpdatedAtValue(session: ChatSession): number {
    const value = Date.parse(session.updatedAt || "");
    return Number.isFinite(value) ? value : 0;
}

export function coalesceDuplicateGroupSessions(
    messages: ChatMessage[],
    sessions: ChatSession[],
): { messages: ChatMessage[]; sessions: ChatSession[]; remappedSessionIds: Map<string, string> } {
    const byIdentity = new Map<string, ChatSession[]>();
    for (const session of sessions) {
        const identity = getGroupSessionIdentity(session);
        if (!identity) continue;
        const group = byIdentity.get(identity) || [];
        group.push(session);
        byIdentity.set(identity, group);
    }

    const remappedSessionIds = new Map<string, string>();
    const replacements = new Map<string, ChatSession>();
    for (const group of byIdentity.values()) {
        if (group.length < 2) continue;
        const ordered = [...group].sort((left, right) => {
            const timeDiff = sessionUpdatedAtValue(left) - sessionUpdatedAtValue(right);
            return timeDiff || left.id.localeCompare(right.id);
        });
        const canonical = ordered[ordered.length - 1];
        const merged = Object.assign({}, ...ordered, {
            id: canonical.id,
            unreadCount: Math.max(...ordered.map((item) => Number(item.unreadCount) || 0)),
            isPinned: ordered.some((item) => item.isPinned),
        }) as ChatSession;
        replacements.set(canonical.id, merged);
        for (const session of ordered) {
            if (session.id !== canonical.id) remappedSessionIds.set(session.id, canonical.id);
        }
    }

    if (remappedSessionIds.size === 0) return { messages, sessions, remappedSessionIds };

    return {
        messages: messages.map((message) => {
            const canonicalId = remappedSessionIds.get(message.sessionId);
            return canonicalId ? { ...message, sessionId: canonicalId } : message;
        }),
        sessions: sessions.flatMap((session) => {
            if (remappedSessionIds.has(session.id)) return [];
            return [replacements.get(session.id) || session];
        }),
        remappedSessionIds,
    };
}

async function finalizeLoadedChatData(
    messages: ChatMessage[],
    sessions: ChatSession[],
    contacts: ChatContact[],
): Promise<{ messages: ChatMessage[]; sessions: ChatSession[]; contacts: ChatContact[] }> {
    const normalized = coalesceDuplicateGroupSessions(messages, sessions);
    if (normalized.remappedSessionIds.size === 0) return { messages, sessions, contacts };

    try {
        const originalSessionByMessageId = new Map(messages.map((message) => [message.id, message.sessionId]));
        const movedMessages = normalized.messages.filter((message) =>
            normalized.remappedSessionIds.has(originalSessionByMessageId.get(message.id) || ""));
        const canonicalIds = new Set(normalized.remappedSessionIds.values());
        const canonicalSessions = normalized.sessions.filter((session) => canonicalIds.has(session.id));
        await chatDb.transaction("rw", chatDb.messages, chatDb.sessions, async () => {
            if (movedMessages.length > 0) await chatDb.messages.bulkPut(movedMessages);
            await chatDb.sessions.bulkDelete(Array.from(normalized.remappedSessionIds.keys()));
            if (canonicalSessions.length > 0) await chatDb.sessions.bulkPut(canonicalSessions);
        });
        console.log(`[ChatDB] Merged ${normalized.remappedSessionIds.size} duplicate group session snapshot(s)`);
    } catch (error) {
        // Keep the cleaned in-memory view even if persistence is temporarily
        // blocked; the next normal session save will retry writing it.
        console.warn("[ChatDB] Failed to persist duplicate group cleanup:", error);
    }
    return { messages: normalized.messages, sessions: normalized.sessions, contacts };
}

/**
 * Initialize IndexedDB and migrate data from localStorage if needed.
 * Returns the loaded data for the in-memory caches.
 */
export async function initChatDb(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // Guard against a lost migration flag while IndexedDB still holds data.
        // The flag lives in volatile localStorage; the actual data lives in the far
        // more durable IndexedDB. The flag can disappear independently of the data
        // (e.g. clearing the "cache" data module, privacy tooling, partial eviction).
        // If we blindly "re-migrated" from now-empty localStorage we would shadow
        // real data with empty caches, and the next write would wipe IndexedDB.
        // So when IDB already has data, treat it as already migrated and reuse it.
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            if (existingCount > 0) {
                window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
                const [messages, sessions, contacts] = await Promise.all([
                    chatDb.messages.toArray(),
                    chatDb.sessions.toArray(),
                    chatDb.contacts.toArray(),
                ]);
                console.log(`[ChatDB] Migration flag missing but IndexedDB has data; reusing it: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
                return finalizeLoadedChatData(messages, sessions, contacts);
            }
        } catch (err) {
            console.warn("[ChatDB] Pre-migration IndexedDB check failed:", err);
        }

        // First run after migration: move localStorage data → IndexedDB
        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) {
                await chatDb.messages.bulkPut(lsMessages);
            }
            if (lsSessions.length > 0) {
                await chatDb.sessions.bulkPut(lsSessions);
            }
            if (lsContacts.length > 0) {
                await chatDb.contacts.bulkPut(lsContacts);
            }

            // Mark as migrated and remove old localStorage data
            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            console.log(`[ChatDB] Migrated from localStorage: ${lsMessages.length} messages, ${lsSessions.length} sessions, ${lsContacts.length} contacts`);

            return finalizeLoadedChatData(lsMessages, lsSessions, lsContacts);
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            // If migration fails, load from localStorage as fallback
            const fallbackMessages: ChatMessage[] = safeParse(window.localStorage.getItem(LS_MESSAGES_KEY));
            const fallbackSessions: ChatSession[] = safeParse(window.localStorage.getItem(LS_SESSIONS_KEY));
            const fallbackContacts: ChatContact[] = safeParse(window.localStorage.getItem(LS_CONTACTS_KEY));
            return finalizeLoadedChatData(fallbackMessages, fallbackSessions, fallbackContacts);
        }
    }

    // Already migrated: load from IndexedDB (retry up to 3 times on failure)
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return finalizeLoadedChatData(messages, sessions, contacts);
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch {}
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    throw new Error("[ChatDB] Failed to load after 3 attempts");
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers (fire-and-forget) ──

export function dbPutMessage(msg: ChatMessage): void {
    chatDb.messages.put(msg).catch(err => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    chatDb.messages.bulkPut(msgs).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
}

export function dbDeleteMessage(id: string): void {
    chatDb.messages.delete(id).catch(err => console.warn("[ChatDB] delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    chatDb.messages.bulkDelete(ids).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session).catch(err => console.warn("[ChatDB] put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
    chatDb.sessions.bulkPut(sessions).catch(err => console.warn("[ChatDB] bulkPut sessions failed:", err));
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
    chatDb.transaction("rw", chatDb.sessions, async () => {
        await chatDb.sessions.clear();
        await chatDb.sessions.bulkPut(sessions);
    }).catch(err => console.warn("[ChatDB] replace sessions failed:", err));
}

export function dbDeleteSession(id: string): void {
    chatDb.sessions.delete(id).catch(err => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    chatDb.contacts.bulkPut(contacts).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    chatDb.contacts.clear().catch(err => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
}
