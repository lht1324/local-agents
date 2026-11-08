// 데몬 최소 지원 버전. 구버전이 계속 돌면 API 변경 시 조용히 깨지므로,
// heartbeat 응답에 실어 보내 데몬이 스스로 업데이트를 안내하게 한다.
// 데몬을 새로 배포할 때 이 값을 올린다.
export const MIN_DAEMON_VERSION = "1.0.4";
