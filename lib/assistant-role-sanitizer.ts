export type AssistantRoleSanitizeOptions = {
    characterName?: string;
    userName?: string;
};

export type AssistantRoleSanitizeResult = {
    text: string;
    detected: boolean;
    removedUserLines: number;
};

const USER_ROLE_LABELS = new Set(["user", "用户", "human", "人类", "{{user}}"]);
const ASSISTANT_ROLE_LABELS = new Set(["assistant", "助手", "ai", "bot", "角色", "{{char}}"]);
const SYSTEM_ROLE_LABELS = new Set(["system", "系统", "developer", "开发者"]);

function normalizeLabel(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function classifyRoleLabel(
    label: string,
    options: AssistantRoleSanitizeOptions,
): "user" | "assistant" | "system" | null {
    const normalized = normalizeLabel(label);
    if (USER_ROLE_LABELS.has(normalized)) return "user";
    if (ASSISTANT_ROLE_LABELS.has(normalized)) return "assistant";
    if (SYSTEM_ROLE_LABELS.has(normalized)) return "system";
    if (options.userName && normalized === normalizeLabel(options.userName)) return "user";
    if (options.characterName && normalized === normalizeLabel(options.characterName)) return "assistant";
    return null;
}

/** Remove transcript-style fake user turns from a direct-chat assistant response. */
export function sanitizeAssistantRoleOutput(
    input: string,
    options: AssistantRoleSanitizeOptions = {},
): AssistantRoleSanitizeResult {
    let detected = false;
    let removedUserLines = 0;
    const kept: string[] = [];
    const prefixPattern = /^\s*(?:\[([^\]\n]{1,48})\]|([^:：\n]{1,48}))\s*[:：]\s*(.*)$/;

    for (const line of String(input ?? "").split("\n")) {
        const match = line.match(prefixPattern);
        if (!match) {
            kept.push(line);
            continue;
        }
        const role = classifyRoleLabel(match[1] || match[2] || "", options);
        if (!role) {
            kept.push(line);
            continue;
        }

        detected = true;
        if (role === "user" || role === "system") {
            if (role === "user") removedUserLines += 1;
            continue;
        }

        // Assistant/character prefixes are redundant inside an assistant message.
        if (match[3]) kept.push(match[3]);
    }

    return {
        text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
        detected,
        removedUserLines,
    };
}
