/* safety-checklist — 클라이언트 설정. API_URL 은 이 상수 1곳에만 존재(§11.1 계정 이전 대비). */
var CONFIG = {
  API_URL: 'https://api.ynes.app',
  SHARED_KEY: 'B3vWj9dp3BUpOIz6OYHQ0fgS5ViBpjKT',
  APP_VER: '0.5.5-002b0f68',
  /* MOCK=true: GAS 미배포 상태에서도 화면 전체 흐름(홈→작성→검토→제출)을
     내장 목 masters/제출 응답으로 검증할 수 있게 하는 개발·데모 스위치.
     Task 6 실배포 후 API_URL·SHARED_KEY 교체와 함께 false 로 전환할 것. */
  MOCK: false,
  /* 주소 이전: 비어 있으면 아무 일도 없다(이 저장소·새 주소 배포는 늘 빈 값). 옛 주소(GitHub Pages)
     저장소에 올리는 사본만 tools/build_moved_site.py 가 새 주소로 채운다 — web/move.js 참고. */
  MOVED_TO: ''
};
