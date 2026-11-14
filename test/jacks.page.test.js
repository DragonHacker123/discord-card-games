import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../games/jacks/page.html', import.meta.url), 'utf8');
const ui = await readFile(new URL('../games/jacks/ui.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../games/jacks/style.css', import.meta.url), 'utf8');

test('the page does not rely on form submits, which sandboxed frames can block', () => {
  assert.doesNotMatch(page, /<form\b/i);
  assert.doesNotMatch(page, /type="submit"/i);
});

test('the opening screen keeps teaching out of the way', () => {
  assert.match(page, /id="tutorialBtn"/);
  assert.match(page, /id="lobbyRulesBtn"/);
  assert.match(ui, /\$\('tutorialBtn'\)\.addEventListener\('click', startTutorial\)/);
  assert.doesNotMatch(page, /class="lede"/);
  assert.doesNotMatch(page, /rules-card/);
});

test('normal prompts don’t explain the rules', () => {
  const prompts = ui.slice(ui.indexOf('function promptFor'), ui.indexOf('function renderPrompt'));
  assert.ok(prompts.length > 0);
  for (const line of ['straight away', 'penalty', 'lowest total', 'worth', 'You drew', 'Swap it or discard it', 'Call Jacks', 'End turn', 'Draw a card', 'Your turn']) {
    assert.ok(!prompts.includes(line), `A prompt still says "${line}"`);
  }
});

test('Call Jacks and End turn sit either side of your cards', () => {
  const row = page.slice(page.indexOf('class="me-row"'), page.indexOf('id="stamp"'));
  const call = row.indexOf('id="callBtn"');
  const seat = row.indexOf('id="meSeat"');
  const end = row.indexOf('id="endTurnBtn"');
  assert.ok(call !== -1 && seat !== -1 && end !== -1);
  assert.ok(call < seat && seat < end);
  assert.match(row, /id="callBtn"[^>]*>Jacks</);
  assert.match(ui, /\$\('callBtn'\)\.addEventListener\('click', \(\) => humanAct\(\{ type: 'callJacks' \}\)\)/);
  assert.match(ui, /\$\('endTurnBtn'\)\.addEventListener\('click', \(\) => humanAct\(\{ type: 'endTurn' \}\)\)/);
});

test('the rules cover the tie, computer player matching and when to call', () => {
  const rules = ui.slice(ui.indexOf('function rulesHtml'), ui.indexOf('Card drawings'));
  assert.match(rules, /Call at the end of your turn/);
  assert.match(rules, /ties for the lowest total, they lose/);
  assert.match(rules, /after 3 to 5 seconds/);
  assert.doesNotMatch(rules, /only try matches with their own cards/);
  assert.doesNotMatch(rules, /Your turn ends as soon as|press Jacks before/);
});

test('computer players take 3 to 5 real seconds to match someone else’s card', () => {
  assert.match(ui, /BOT_OTHER_MATCH_MS = \[3000, 5000\]/);
  assert.match(ui, /jitter\(\.\.\.BOT_OTHER_MATCH_MS\) \* ui\.speed/);
});

test('picking up from the discard pile is a setting, and pressing the pile does it', () => {
  assert.match(page, /type="checkbox" id="setDrawFromDiscard"/);
  assert.match(ui, /\$\('setDrawFromDiscard'\)\.checked = settings\.drawFromDiscard/);
  assert.match(ui, /drawFromDiscard: \$\('setDrawFromDiscard'\)\.checked/);
  assert.match(ui, /humanAct\(\{ type: 'takeDiscard' \}\)/);
  assert.match(ui, /humanAct\(\{ type: 'place', slot \}\)/);
});

test('the rules say what Cameron decided about giving and picking up', () => {
  const rules = ui.slice(ui.indexOf('function takeDiscardLines'), ui.indexOf('Card drawings'));
  assert.match(rules, /they get a card from the draw pile instead/);
  assert.match(rules, /which of your empty places it goes into/);
  assert.match(rules, /Picking up doesn’t reopen matching/);
  assert.doesNotMatch(rules, /just stays empty|with no cards of your own\.<|match the card now on top/);
});

test('the discard pile is a button that discards the card you drew', () => {
  assert.match(page, /<button type="button" id="discardPile"/);
  assert.match(ui, /\$\('discardPile'\)\.addEventListener\('click', onDiscardPileClick\)/);
  assert.match(ui, /humanAct\(\{ type: 'discard' \}\)/);
  assert.doesNotMatch(ui, /Discard it/);
});

test('there’s no Match button: you pick a card, then press the discard pile', () => {
  assert.doesNotMatch(page, /matchBtn/);
  assert.doesNotMatch(ui, /matchBtn|toggleMatchMode|ui\.matchMode/);
  assert.match(ui, /humanAct\(matchPickAction\(\)\)/);
});

test('there’s no game record to look back at, so players have to remember', () => {
  assert.doesNotMatch(page, /id="log"|Game record/);
  assert.doesNotMatch(ui, /writeLog|describeEvent|appendLogLine/);
  assert.doesNotMatch(css, /\.log\b/);
  assert.match(page, /id="copyRecordBtn"/);
});

test('you pick a card to give by clicking it', () => {
  assert.match(ui, /humanAct\(\{ type: 'giveCard', slot \}\)/);
});

test('the computer players can be slowed down, and start at normal speed', () => {
  const speeds = page.slice(page.indexOf('id="botSpeed"'), page.indexOf('</select>', page.indexOf('id="botSpeed"')));
  assert.match(speeds, /value="0\.33">Slow</);
  assert.match(speeds, /value="1" selected>Normal</);
  assert.match(speeds, /value="3">Fast</);
});

test('the corner buttons float, so they can’t push your cards up', () => {
  assert.match(css, /\.turn-btn \{[^}]*position: absolute/);
  assert.doesNotMatch(css, /\.me-row \{[^}]*flex-wrap/);
});

test('the rules box has a cross and an OK button too', () => {
  assert.match(page, /id="rulesCloseBtn"[^>]*aria-label="Close rules"/);
  assert.match(page, /id="rulesOkBtn"[^>]*>OK</);
});

test('the settings menu has a cross and an OK button that both close it', () => {
  assert.match(page, /id="settingsCloseBtn"[^>]*aria-label="Close settings"/);
  assert.match(page, /id="settingsOkBtn"[^>]*>OK</);
  assert.match(ui, /\$\('settingsCloseBtn'\)\.addEventListener\('click', closeSettings\)/);
  assert.match(ui, /\$\('settingsOkBtn'\)\.addEventListener\('click', closeSettings\)/);
});

test('the test page still works out its own view', () => {
  assert.match(ui, /const myView = \(\) => \(online \? game\.state : viewFor\(game\.state, ME\)\);/);
});

test('every rule is confirmed, so there’s no list of assumptions', () => {
  assert.doesNotMatch(ui, /Assumed, so please check/);
});
