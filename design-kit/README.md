# 디자인 킷 — control

> 모든 신호가 한눈에 들어오는 관제실처럼, 어둠 속에서 상태를 지켜보는 고밀도 화면

antigravity **design** 저장소가 내보낸 검증된 디자인 소스다. 이 킷의 값은 **고르는 것**이지
프로젝트에서 발명하지 않는다. 색을 새로 만들거나 raw hex를 쓰면 계약 위반이다.

## 쓰는 법

```html
<link rel="stylesheet" href="./tokens.css">
<link rel="stylesheet" href="./components.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/wan2land/d2coding/d2coding-subset.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
```

- 색·폰트·간격은 전부 `tokens.css`의 CSS 변수다. 값을 직접 쓰지 말고 `var(--accent)`처럼 참조한다.
  (모션 지속시간도 `--motion-duration` 으로 있지만, `components.css` 자체의 전환은 접근성 하한인
  `150ms` 고정이다 — `prefers-reduced-motion` 에서는 전부 꺼진다.)
- 계약 검사: `node verify.mjs <소스디렉토리>` — raw 색, focus 제거, 이모지 아이콘, AI 그라데이션을
  잡는다. error가 있으면 종료코드 1. **CI에 연결하는 책임은 이 프로젝트에 있다**(킷은 강제하지 못한다).
- 컴포넌트는 `dk-` 네임스페이스 클래스를 쓴다(`.dk-button`, `.dk-input`, `.dk-card`, `.dk-table`).
- **페이지 바탕에 토큰을 적용하는 한 줄은 이 프로젝트가 넣는다** — 킷은 `:root` 변수만 내보내고
  `body`에 아무것도 적용하지 않는다(소비 프로젝트의 전역 스타일을 킷이 정하지 않기 위해서다).
  이 줄이 없으면 다크로 전환해도 바탕은 흰색, 글자는 어두운 색 그대로라 카드 본문이 읽히지 않는다.

  ```css
  body { background: var(--bg); color: var(--text); }
  ```
- 다크 모드는 `<html data-theme="dark">`로 전환한다(위 한 줄이 있어야 실제로 바뀐다). 강제 다크는 금지.
- 기계 판독용 값은 `tokens.json`에 있다(빌드 도구·디자인 툴 연동용).

## 컴포넌트 조합

modifier는 base 클래스와 **함께** 쓴다(`dk-button` + `dk-button--md`).

```html
<button class="dk-button dk-button--md">저장</button>
<button class="dk-button dk-icon-button" aria-label="닫기"><svg …></svg></button>

<label for="q">검색어</label>
<input id="q" class="dk-input dk-input--md" type="search">
<input class="dk-input dk-input--md" aria-invalid="true" aria-describedby="err">
<p id="err">형식이 올바르지 않습니다</p>

<article class="dk-card">
  <header class="dk-card__header"><h3>제목</h3></header>
  <div class="dk-card__content">본문</div>
  <footer class="dk-card__footer"><button class="dk-button dk-button--sm">확인</button></footer>
</article>

<dialog class="dk-dialog dk-dialog--md" aria-labelledby="dlg-title">
  <h2 id="dlg-title">확인</h2>
</dialog>

<table class="dk-table dk-table--default">
  <tr class="dk-row" aria-selected="true"><td>선택된 행</td></tr>
</table>
```

**소비 측이 책임지는 동작**(CSS가 대신해 주지 않는다):

- 아이콘 버튼에는 `aria-label`을 반드시 준다 — 아이콘만으로는 이름이 없다.
- 입력에는 `<label for>`를 연결한다. 오류는 `aria-invalid` + `aria-describedby`로 알린다.
- `<dialog>`는 `showModal()`로 열고 focus 트랩·복귀·ESC 닫기를 구현한다.
- 표의 선택 상태는 `aria-selected`로 표시한다 — 색 틴트는 보조 신호일 뿐이다.
- 테마 전환은 `document.documentElement.dataset.theme = "dark"`.
## 접근성 하한 (uiux-core@1)

| 항목 | 값 |
|---|---|
| 본문 대비 | 4.5:1 |
| 큰 텍스트·UI 경계 | 3:1 |
| 터치 타깃 | 44×44px (Material 48) |
| 본문 줄길이 | 45~75자 |
| 전환 시간 | 150~300ms |

focus 표시는 제거하지 않는다. `outline: none`만 쓰고 대체 표시를 두지 않으면 키보드 사용자가 길을 잃는다.

## 금지

- decorative-gradient
- expressive-motion
- pastel-palette
- rounded-corners-large
- ai-purple-pink-gradient
- emoji-icon
- harsh-neon
- rough-motion
- forced-dark-mode
- outline-none-without-replacement

## 출처·재현

이 킷은 `design-kit.mjs`가 프리셋 `control`와 `uiux-core@1`에서 결정론으로 만들었다.
정확한 출처·해시·검증 결과는 `kit-manifest.json`에 있다. 수동 편집한 파일은 다음 내보내기에서 덮인다.
갱신: `node scripts/design-kit.mjs --preset control --out <이 디렉토리>` (design 저장소에서).

킷 계약 버전: 2
