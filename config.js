/* safety-checklist — 클라이언트 설정. API_URL 은 이 상수 1곳에만 존재(§11.1 계정 이전 대비). */
var CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbyk8g0hK_cPK0a8gl7FPGVbGs33I5mEfHNsVdW_pHlDyEcqILwR2KvNXCYOoYZRRJNJaw/exec',
  SHARED_KEY: 'B3vWj9dp3BUpOIz6OYHQ0fgS5ViBpjKT',
  APP_VER: '0.5.5-aac2023f',
  /* MOCK=true: GAS 미배포 상태에서도 화면 전체 흐름(홈→작성→검토→제출)을
     내장 목 masters/제출 응답으로 검증할 수 있게 하는 개발·데모 스위치.
     Task 6 실배포 후 API_URL·SHARED_KEY 교체와 함께 false 로 전환할 것. */
  MOCK: false
};
