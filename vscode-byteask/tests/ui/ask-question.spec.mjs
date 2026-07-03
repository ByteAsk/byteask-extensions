// Regression suite for the multi-choice "ask the user a question" tool --
// the `item/tool/requestUserInput` server request, styled after Claude
// Code's "AskUserQuestion" card (title + close, prompt, labeled options with
// descriptions, an "Other" free-text fallback, a "Submit answers" button,
// Esc-to-cancel). This is a real server-initiated RPC: chatViewProvider.ts
// posts `{type:'userInputRequest', requestId, questions}` to the webview and
// blocks a Promise until the webview replies with `userInputAnswer` (or
// `userInputCancel`) carrying the same requestId -- so the webview's
// responsibility, tested here, is purely: render every question, capture a
// selection or free-text answer per question, and post back the right
// shape when the user acts.
import { test, expect } from './fixtures.mjs';

function singleChoiceRequest(overrides = {}) {
  return {
    type: 'userInputRequest',
    requestId: 1,
    questions: [
      {
        id: 'q1',
        header: 'Which approach should I take?',
        question: 'There are two ways to fix this bug. Pick one:',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Patch the symptom', description: 'Quick, low-risk, does not address the root cause.' },
          { label: 'Fix the root cause', description: 'Slower, but removes the underlying bug entirely.' },
        ],
      },
    ],
    ...overrides,
  };
}

test.describe('ask-user-question (item/tool/requestUserInput)', () => {
  test('renders the card with title, prompt, options, and descriptions', async ({ chat }) => {
    await chat.post(singleChoiceRequest());

    const card = chat.page.locator('.user-input-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.ui-title')).toHaveText('Which approach should I take?');
    await expect(card.locator('.ui-prompt')).toHaveText('There are two ways to fix this bug. Pick one:');

    const options = card.locator('.ui-option');
    // 2 real options + 1 synthetic "Other" row since isOther is true.
    await expect(options).toHaveCount(3);
    await expect(options.nth(0).locator('.ui-option-label')).toHaveText('Patch the symptom');
    await expect(options.nth(0).locator('.ui-option-desc')).toHaveText('Quick, low-risk, does not address the root cause.');
    await expect(options.nth(1).locator('.ui-option-label')).toHaveText('Fix the root cause');
    await expect(options.nth(2).locator('.ui-option-label')).toHaveText('Other');

    // Claude-Code-style chrome: a close button and an Esc-to-cancel hint.
    await expect(card.locator('.ui-close')).toBeVisible();
    await expect(card.locator('.ui-hint')).toHaveText('Esc to cancel');
    await expect(card.locator('.ui-submit')).toContainText('Submit answers');
  });

  test('selecting an option and submitting posts the right answer shape back', async ({ chat }) => {
    await chat.post(singleChoiceRequest());
    const card = chat.page.locator('.user-input-card');

    await card.locator('.ui-option').nth(1).click(); // "Fix the root cause"
    await expect(card.locator('.ui-option').nth(1)).toHaveClass(/selected/);
    // Only one option selected at a time (single-choice UX).
    await expect(card.locator('.ui-option').nth(0)).not.toHaveClass(/selected/);

    await card.locator('.ui-submit').click();

    const sent = await chat.sent();
    const answer = sent.find((m) => m.type === 'userInputAnswer');
    expect(answer).toBeTruthy();
    expect(answer.requestId).toBe(1);
    expect(answer.answers).toEqual({ q1: { answers: ['Fix the root cause'] } });

    // The card visibly reflects that it's done, and its controls are
    // disabled so a stray click can't send a second answer.
    await expect(card).toHaveClass(/answered/);
    await expect(card.locator('.ui-submit')).toBeDisabled();
  });

  test('typing a free-text "Other" answer and submitting sends the typed text', async ({ chat }) => {
    await chat.post(singleChoiceRequest());
    const card = chat.page.locator('.user-input-card');

    const otherRow = card.locator('.ui-option-other');
    await otherRow.locator('.ui-other-input').click();
    await otherRow.locator('.ui-other-input').fill('Actually, rewrite the whole module');
    await expect(otherRow).toHaveClass(/selected/);

    await card.locator('.ui-submit').click();

    const sent = await chat.sent();
    const answer = sent.find((m) => m.type === 'userInputAnswer');
    expect(answer.answers).toEqual({ q1: { answers: ['Actually, rewrite the whole module'] } });
  });

  test('submitting with nothing selected sends an empty answer for that question, not a crash', async ({ chat }) => {
    await chat.post(singleChoiceRequest());
    const card = chat.page.locator('.user-input-card');
    await card.locator('.ui-submit').click();

    const sent = await chat.sent();
    const answer = sent.find((m) => m.type === 'userInputAnswer');
    expect(answer.answers).toEqual({ q1: { answers: [] } });
  });

  test('clicking the close button cancels without submitting an answer', async ({ chat }) => {
    await chat.post(singleChoiceRequest());
    const card = chat.page.locator('.user-input-card');

    await card.locator('.ui-option').nth(0).click(); // pick something first
    await card.locator('.ui-close').click();

    const sent = await chat.sent();
    expect(sent.find((m) => m.type === 'userInputAnswer')).toBeFalsy();
    const cancel = sent.find((m) => m.type === 'userInputCancel');
    expect(cancel).toBeTruthy();
    expect(cancel.requestId).toBe(1);

    // The card itself is gone -- cancelling removes it, it doesn't just
    // disable it (that's the "answered" treatment, a different state).
    await expect(card).toHaveCount(0);
  });

  test('pressing Escape cancels the same way as the close button', async ({ chat }) => {
    await chat.post(singleChoiceRequest());
    await chat.page.keyboard.press('Escape');

    const sent = await chat.sent();
    const cancel = sent.find((m) => m.type === 'userInputCancel');
    expect(cancel).toBeTruthy();
    await expect(chat.page.locator('.user-input-card')).toHaveCount(0);
  });

  test('Escape after an answer was already submitted does not double-send', async ({ chat }) => {
    await chat.post(singleChoiceRequest());
    const card = chat.page.locator('.user-input-card');
    await card.locator('.ui-option').nth(0).click();
    await card.locator('.ui-submit').click();

    await chat.page.keyboard.press('Escape');

    const sent = await chat.sent();
    const answers = sent.filter((m) => m.type === 'userInputAnswer');
    const cancels = sent.filter((m) => m.type === 'userInputCancel');
    expect(answers.length).toBe(1);
    expect(cancels.length).toBe(0);
  });

  test('a question with no options at all is free-text only and still submits', async ({ chat }) => {
    await chat.post({
      type: 'userInputRequest',
      requestId: 7,
      questions: [
        {
          id: 'free1',
          header: 'What should the new endpoint be called?',
          question: '',
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    });

    const card = chat.page.locator('.user-input-card');
    await expect(card.locator('.ui-option')).toHaveCount(1); // just the synthetic "Other" row
    await card.locator('.ui-other-input').fill('/api/v2/widgets');
    await card.locator('.ui-submit').click();

    const sent = await chat.sent();
    const answer = sent.find((m) => m.type === 'userInputAnswer');
    expect(answer.answers).toEqual({ free1: { answers: ['/api/v2/widgets'] } });
  });

  test('a secret question masks the free-text input', async ({ chat }) => {
    await chat.post({
      type: 'userInputRequest',
      requestId: 9,
      questions: [
        { id: 's1', header: 'Enter the API token', question: '', isOther: true, isSecret: true, options: null },
      ],
    });
    const input = chat.page.locator('.user-input-card .ui-other-input');
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('multiple questions in one request render as separate blocks with one shared submit', async ({ chat }) => {
    await chat.post({
      type: 'userInputRequest',
      requestId: 2,
      questions: [
        {
          id: 'q1',
          header: 'Which database?',
          question: '',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Postgres', description: '' },
            { label: 'SQLite', description: '' },
          ],
        },
        {
          id: 'q2',
          header: 'Which cache?',
          question: '',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Redis', description: '' },
            { label: 'None', description: '' },
          ],
        },
      ],
    });

    const card = chat.page.locator('.user-input-card');
    await expect(card.locator('.ui-question-block')).toHaveCount(2);
    // Only one close button and one submit button for the whole card.
    await expect(card.locator('.ui-close')).toHaveCount(1);
    await expect(card.locator('.ui-submit')).toHaveCount(1);

    const blocks = card.locator('.ui-question-block');
    await blocks.nth(0).locator('.ui-option', { hasText: 'Postgres' }).click();
    await blocks.nth(1).locator('.ui-option', { hasText: 'Redis' }).click();
    await card.locator('.ui-submit').click();

    const sent = await chat.sent();
    const answer = sent.find((m) => m.type === 'userInputAnswer');
    expect(answer.answers).toEqual({
      q1: { answers: ['Postgres'] },
      q2: { answers: ['Redis'] },
    });
  });

  test('selecting an option after typing "Other" text deselects Other, and vice versa', async ({ chat }) => {
    await chat.post(singleChoiceRequest());
    const card = chat.page.locator('.user-input-card');
    const otherRow = card.locator('.ui-option-other');

    await otherRow.locator('.ui-other-input').fill('something custom');
    await expect(otherRow).toHaveClass(/selected/);

    await card.locator('.ui-option').nth(0).click(); // "Patch the symptom"
    await expect(otherRow).not.toHaveClass(/selected/);
    await expect(card.locator('.ui-option').nth(0)).toHaveClass(/selected/);

    // The typed Other text is still there, but shouldn't be sent since
    // Other is no longer the selected option.
    await card.locator('.ui-submit').click();
    const sent = await chat.sent();
    const answer = sent.find((m) => m.type === 'userInputAnswer');
    expect(answer.answers).toEqual({ q1: { answers: ['Patch the symptom'] } });
  });

  test('a second request while one is pending renders both cards independently', async ({ chat }) => {
    await chat.post(singleChoiceRequest({ requestId: 1 }));
    await chat.post(
      singleChoiceRequest({
        requestId: 2,
        questions: [
          { id: 'qA', header: 'Second question', question: '', isOther: false, isSecret: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
        ],
      })
    );

    const cards = chat.page.locator('.user-input-card');
    await expect(cards).toHaveCount(2);

    // Answering the second card doesn't affect the first.
    await cards.nth(1).locator('.ui-option', { hasText: 'No' }).click();
    await cards.nth(1).locator('.ui-submit').click();

    const sent = await chat.sent();
    const answer = sent.find((m) => m.type === 'userInputAnswer' && m.requestId === 2);
    expect(answer.answers).toEqual({ qA: { answers: ['No'] } });
    await expect(cards.nth(0)).not.toHaveClass(/answered/);
    await expect(cards.nth(1)).toHaveClass(/answered/);
  });

  test('the thinking indicator is dismissed when a question card arrives', async ({ chat }) => {
    await chat.post({ type: 'turnStarted' });
    await expect(chat.page.locator('#thinking')).not.toHaveClass(/hidden/);

    await chat.post(singleChoiceRequest());
    await expect(chat.page.locator('#thinking')).toHaveClass(/hidden/);
  });
});
