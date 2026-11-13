// 기준점 비교만 남는다. 기준점 자체는 서버(cloud_messages)에 있고 로컬에 저장하지 않는다.
export interface Watermark {
    createdAt: number;
    messageId: string;
}

// (createdAt, messageId) 쌍 비교. 시간이 같으면 id 순.
// 서버 워터마크도 같은 규칙으로 정렬해 뽑으므로 두 판단이 정확히 일치한다.
export function isNewer(createdAt: number | null, messageId: string, cursor: Watermark | null): boolean {
    if (!cursor) {
        return true;
    }
    const at = createdAt ?? 0;
    if (at !== cursor.createdAt) {
        return at > cursor.createdAt;
    }
    return messageId > cursor.messageId;
}
