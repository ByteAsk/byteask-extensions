// ByteAsk chat webview. Vanilla JS, no framework, no bundler — matches the
// extension's zero-runtime-dependency build. Talks to chatViewProvider.ts
// via postMessage in both directions.
//
// No local persistence here: the extension replays the real transcript from
// ~/.byteask (via thread/resume) every time this view is created, so there is
// nothing for the webview itself to cache -- doing so would risk showing a
// stale second copy alongside the freshly replayed real one.
(function () {
  const vscode = acquireVsCodeApi();

  const welcomeEl = document.getElementById('welcome');
  const onboardingEl = document.getElementById('onboarding');
  const obTitleEl = document.getElementById('obTitle');
  const obBodyEl = document.getElementById('obBody');
  const obPrimaryBtn = document.getElementById('obPrimaryBtn');
  const obRetryBtn = document.getElementById('obRetryBtn');
  const obManualSummary = document.getElementById('obManualSummary');
  const obManualInstall = document.getElementById('obManualInstall');
  const obManualLogin = document.getElementById('obManualLogin');
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');
  const sessionTitleEl = document.getElementById('sessionTitle');
  const historyBtn = document.getElementById('historyBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const historyPanel = document.getElementById('historyPanel');
  const historySearch = document.getElementById('historySearch');
  const historyList = document.getElementById('historyList');
  const thinkingEl = document.getElementById('thinking');
  const thinkingLabelEl = document.getElementById('thinkingLabel');
  const attachmentsEl = document.getElementById('attachments');
  const plusBtn = document.getElementById('plusBtn');
  const plusMenu = document.getElementById('plusMenu');
  const slashBtn = document.getElementById('slashBtn');
  const slashMenu = document.getElementById('slashMenu');
  const slashSearch = document.getElementById('slashSearch');
  const slashList = document.getElementById('slashList');

  let titleSet = false; // only the FIRST user message in a thread names it, like Claude Code
  let lastSessions = [];
  let pendingAttachment = null; // { path, name, kind, content? } picked via "Upload from computer"

  // Item kinds that get their own rendering. Everything else (userMessage —
  // shown eagerly on send instead — plus plan/webSearch/imageView/etc. not
  // yet supported in v1) is silently skipped rather than dumped as "[type]".
  const RENDERED_KINDS = new Set(['agentMessage', 'reasoning', 'commandExecution', 'fileChange']);

  /** @type {Map<string, HTMLElement>} itemId -> its element */
  const itemEls = new Map();
  /** @type {Map<string, string>} itemId -> accumulated raw text (for final markdown render) */
  const itemText = new Map();

  // "Stick to bottom" auto-scroll: once the user sends a message, we anchor
  // that message near the TOP of the view (see addUserMessage) and leave
  // the rest empty for the response to grow into -- matching Cursor's
  // behavior of a large breathable gap right after sending, rather than
  // snapping to the very bottom on every token. Streaming updates only
  // auto-follow if the view is already near the bottom (e.g. later in a
  // long, already-scrolled conversation); they never yank the view back
  // down out from under someone who scrolled up to read earlier context.
  let stickToBottom = true;

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  messagesEl.addEventListener('scroll', () => {
    // While anchor mode is active, stickToBottom is owned explicitly by
    // beginAnchor()/updateAnchorSpacer() -- not by this listener. The
    // anchor's reserved gap is deliberately only ~40px from the true
    // scrollable bottom (reserve = clientHeight - 40), which is *narrower*
    // than isNearBottom()'s 80px "close enough" threshold: the anchor's own
    // programmatic scrollTop assignment fires this same native 'scroll'
    // event, and without this guard isNearBottom() would immediately read
    // "yes, near the bottom" and flip stickToBottom back to true, snapping
    // the very next appended item straight to the bottom and defeating the
    // anchor entirely.
    if (anchorMode) {
      return;
    }
    stickToBottom = isNearBottom();
  });

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    stickToBottom = true;
  }

  function maybeFollow() {
    if (stickToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  /**
   * `el.offsetTop` is relative to `el.offsetParent` (the nearest
   * *positioned* ancestor), NOT necessarily the scrollable container it
   * visually sits in -- #messages itself isn't positioned, so offsetTop was
   * silently resolving relative to <body> instead, producing a scroll
   * target with no relationship to where the message actually was. This
   * computes the element's true offset within `container`'s own scroll
   * coordinate space, independent of the offsetParent chain.
   */
  function offsetWithin(el, container) {
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return elRect.top - containerRect.top + container.scrollTop;
  }

  // ── Scroll-anchor spacer ─────────────────────────────────────────────────
  // Positioning a freshly-sent message near the TOP of the view only works
  // if the container can actually scroll that far -- but a message that was
  // just appended is the LAST thing in the list, so there's no content below
  // it yet to make that scroll position reachable; the browser silently
  // clamps scrollTop to scrollHeight-clientHeight instead (verified with a
  // real browser via tests/ui -- this was the actual bug, not a timing
  // issue). A trailing spacer reserves that room up front; as the real
  // response streams in and grows, the spacer shrinks by the same amount so
  // the empty gap visibly fills in, exactly like Cursor's before/after.
  let anchorMode = false;
  let anchorBaselineBottom = 0;

  function ensureSpacer() {
    let spacer = document.getElementById('scrollSpacer');
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.id = 'scrollSpacer';
      messagesEl.appendChild(spacer);
    } else if (messagesEl.lastElementChild !== spacer) {
      messagesEl.appendChild(spacer); // keep it the last child
    }
    return spacer;
  }

  // The last non-spacer child's bottom edge, in *absolute scroll-content*
  // coordinates (not scrollHeight, and not raw getBoundingClientRect()).
  // scrollHeight is out because it's never less than clientHeight per spec,
  // and #messages is a `flex: 1` item that stretches to fill its allocated
  // space -- so scrollHeight silently reports the stretched box height
  // instead of the true (smaller) content height whenever a conversation is
  // short. Raw getBoundingClientRect() is out too: it's viewport-relative,
  // and scrollTop changes between the baseline capture in beginAnchor() and
  // later measurements here (the anchor's own RAF-deferred scroll
  // assignment, for one) -- comparing viewport-relative rects across a
  // scrollTop change reads as spurious growth/shrinkage that has nothing to
  // do with actual content size. Converting to the container's own
  // scroll-content coordinate space (same trick offsetWithin() uses: strip
  // out the viewport offset, add back scrollTop) is invariant to all of
  // that.
  function lastContentBottom() {
    const children = messagesEl.children;
    const containerTop = messagesEl.getBoundingClientRect().top;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i].id !== 'scrollSpacer') {
        return children[i].getBoundingClientRect().bottom - containerTop + messagesEl.scrollTop;
      }
    }
    return messagesEl.scrollTop;
  }

  function beginAnchor(el) {
    const spacer = ensureSpacer();
    spacer.style.height = '0px';
    anchorBaselineBottom = lastContentBottom();
    spacer.style.height = Math.max(0, messagesEl.clientHeight - 40) + 'px';
    anchorMode = true;
    // Don't rely solely on the native 'scroll' event to flip this off: if
    // the computed target below happens to equal the current scrollTop
    // (e.g. an early, near-empty conversation), assigning scrollTop is a
    // no-op and the event never fires, leaving stickToBottom stuck at
    // whatever it was before and causing maybeFollow() to yank the view
    // back down during what should be anchored mode.
    stickToBottom = false;
    requestAnimationFrame(() => {
      messagesEl.scrollTop = Math.max(0, offsetWithin(el, messagesEl) - 12);
    });
  }

  function updateAnchorSpacer() {
    if (!anchorMode) {
      return;
    }
    const spacer = document.getElementById('scrollSpacer');
    if (!spacer) {
      anchorMode = false;
      return;
    }
    const reserve = Math.max(0, messagesEl.clientHeight - 40);
    const growth = lastContentBottom() - anchorBaselineBottom;
    const nextHeight = Math.max(0, reserve - growth);
    spacer.style.height = nextHeight + 'px';
    if (nextHeight <= 0) {
      anchorMode = false; // fully absorbed by real content; back to normal flow
      // The reserve was sized to exactly the gap between the anchor point
      // and the bottom of the viewport, so depleting it means real content
      // has now grown to fill that gap (and possibly beyond it) -- this is
      // "caught up," the same state a normal stick-to-bottom chat would be
      // in. Set it unconditionally rather than checking isNearBottom():
      // scrollTop is still sitting at its anchored position at this point
      // (maybeFollow() hasn't run yet), so scrollHeight-scrollTop-clientHeight
      // would read as "far from bottom" even though it's exactly caught up --
      // the whole reason this resync exists is to correct for that.
      stickToBottom = true;
    }
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Minimal markdown: fenced code blocks, inline code, bold, italic, links. */
  function renderMarkdown(raw) {
    const escaped = escapeHtml(raw);
    const withFences = escaped.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const cls = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${cls}>${code}</code></pre>`;
    });
    const withInlineCode = withFences.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    const withBold = withInlineCode.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    const withItalic = withBold.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    const withLinks = withItalic.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    return withLinks.replace(/\n/g, '<br/>');
  }

  function appendEl(el) {
    const spacer = document.getElementById('scrollSpacer');
    if (spacer) {
      messagesEl.insertBefore(el, spacer);
    } else {
      messagesEl.appendChild(el);
    }
    updateAnchorSpacer();
    maybeFollow();
    return el;
  }

  function addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = text;
    appendEl(el);
    beginAnchor(el);
    if (!titleSet) {
      titleSet = true;
      const oneLine = text.replace(/\s+/g, ' ').trim();
      sessionTitleEl.textContent = oneLine.length > 48 ? oneLine.slice(0, 48) + '…' : oneLine || 'New chat';
    }
  }

  function addErrorMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg error';
    el.textContent = text;
    appendEl(el);
  }

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.textContent = text;
    appendEl(el);
  }

  function makeToolRow(labelText) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.innerHTML = '<div class="dot"></div><div class="body"><div class="label"></div><div class="detail"></div></div>';
    row.querySelector('.label').textContent = labelText;
    return row;
  }

  function ensureItemEl(item) {
    if (!RENDERED_KINDS.has(item.type)) {
      return null;
    }
    if (itemEls.has(item.id)) {
      return itemEls.get(item.id);
    }
    let el;
    if (item.type === 'agentMessage') {
      el = document.createElement('div');
      el.className = 'msg assistant' + (item.phase === 'commentary' ? ' commentary' : '');
      appendEl(el);
    } else if (item.type === 'reasoning') {
      el = document.createElement('details');
      el.className = 'reasoning';
      el.innerHTML = '<summary>Thinking</summary><div class="content"></div>';
      appendEl(el);
    } else if (item.type === 'commandExecution') {
      el = makeToolRow('Bash');
      el.querySelector('.detail').textContent = item.command || '';
      appendEl(el);
    } else if (item.type === 'fileChange') {
      el = makeToolRow('Edit');
      appendEl(el);
    }
    itemEls.set(item.id, el);
    return el;
  }

  function appendDeltaToItem(itemId, delta, isReasoning) {
    const prev = itemText.get(itemId) || '';
    const next = prev + delta;
    itemText.set(itemId, next);
    let el = itemEls.get(itemId);
    if (!el) {
      // Delta arrived before item/started (shouldn't normally happen, but
      // degrade gracefully by creating a plain element).
      if (isReasoning) {
        el = document.createElement('details');
        el.className = 'reasoning';
        el.innerHTML = '<summary>Thinking</summary><div class="content"></div>';
      } else {
        el = document.createElement('div');
        el.className = 'msg assistant';
      }
      appendEl(el);
      itemEls.set(itemId, el);
    }
    const target = isReasoning ? el.querySelector('.content') : el;
    if (target) {
      target.textContent = next; // plain text while streaming; markdown applied on completion
    }
    updateAnchorSpacer();
    maybeFollow();
  }

  function toolRowStatusClass(item) {
    if (item.type === 'commandExecution') {
      if (item.status === 'completed') return item.exitCode === 0 ? 'done' : 'failed';
      if (item.status === 'failed') return 'failed';
      return '';
    }
    if (item.type === 'fileChange') {
      if (item.status === 'completed') return 'done';
      if (item.status === 'declined' || item.status === 'failed') return 'declined';
      return '';
    }
    return '';
  }

  function finalizeItem(item) {
    const el = itemEls.get(item.id);
    if (!el) {
      return;
    }
    if (item.type === 'agentMessage') {
      el.innerHTML = renderMarkdown(item.text || '');
    } else if (item.type === 'reasoning') {
      const text = (item.content || []).join('\n') || (item.summary || []).join('\n');
      if (!text.trim()) {
        el.remove(); // nothing was ever said — don't show an empty "Thinking" block
        itemEls.delete(item.id);
        return;
      }
      const content = el.querySelector('.content');
      if (content) {
        content.textContent = text;
      }
    } else if (item.type === 'commandExecution') {
      el.className = 'tool-row ' + toolRowStatusClass(item);
      el.querySelector('.label').textContent = 'Bash' + (item.exitCode != null ? ` (exit ${item.exitCode})` : '');
      el.querySelector('.detail').textContent = item.command || '';
    } else if (item.type === 'fileChange') {
      el.className = 'tool-row ' + toolRowStatusClass(item);
      const names = (item.changes || []).map((c) => c.path.split('/').pop()).join(', ');
      const verb = item.status === 'completed' ? 'Edited' : item.status === 'declined' ? 'Declined edit to' : 'Editing';
      el.querySelector('.label').textContent = `${verb} ${names}`;
    }
    updateAnchorSpacer();
    maybeFollow();
  }

  function addApprovalCard(msg) {
    const card = document.createElement('div');
    card.className = 'approval-card';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = msg.kind === 'fileChange' ? 'Approve file change?' : 'Approve running this command?';
    card.appendChild(title);

    const summary = document.createElement('div');
    summary.textContent = msg.title;
    card.appendChild(summary);

    if (msg.kind === 'command' && msg.body) {
      const body = document.createElement('div');
      body.className = 'body-text';
      body.style.marginTop = '4px';
      body.textContent = msg.body;
      card.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    if (msg.kind === 'fileChange') {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'link';
      viewBtn.textContent = 'View diff';
      viewBtn.onclick = () => vscode.postMessage({ type: 'viewDiff', requestId: msg.requestId });
      actions.appendChild(viewBtn);
    }

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.onclick = () => {
      vscode.postMessage({ type: 'approvalDecision', requestId: msg.requestId, decision: 'accept' });
      title.textContent += ' — accepted';
      actions.remove();
    };

    const declineBtn = document.createElement('button');
    declineBtn.className = 'secondary';
    declineBtn.textContent = 'Decline';
    declineBtn.onclick = () => {
      vscode.postMessage({ type: 'approvalDecision', requestId: msg.requestId, decision: 'decline' });
      title.textContent += ' — declined';
      actions.remove();
    };

    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    card.appendChild(actions);

    appendEl(card);
  }

  // ── Multi-choice question card (item/tool/requestUserInput) ─────────────
  // Claude Code's "AskUserQuestion" tool, mirrored: a titled card per
  // question with a close (X), the prompt, selectable option rows (label +
  // description), an optional free-text "Other" row, and a single submit
  // button covering every question in the request (the server sends one
  // `questions` array per request, not one request per question).
  function addUserInputCard(msg) {
    const card = document.createElement('div');
    card.className = 'user-input-card';

    // Per-question selection state: id -> { selectedLabel, otherText }
    const state = new Map();
    for (const q of msg.questions) {
      state.set(q.id, { selectedLabel: null, otherText: '' });
    }

    let cancelled = false;
    let keyHandler = null;
    function teardownKeyHandler() {
      if (keyHandler) {
        document.removeEventListener('keydown', keyHandler);
        keyHandler = null;
      }
    }
    function cancel() {
      if (cancelled) return;
      cancelled = true;
      teardownKeyHandler();
      vscode.postMessage({ type: 'userInputCancel', requestId: msg.requestId });
      card.remove();
    }

    function submit() {
      if (cancelled) return;
      teardownKeyHandler();
      const answers = {};
      for (const q of msg.questions) {
        const s = state.get(q.id);
        const picked = [];
        if (s.selectedLabel === '__other__') {
          if (s.otherText.trim()) picked.push(s.otherText.trim());
        } else if (s.selectedLabel) {
          picked.push(s.selectedLabel);
        }
        answers[q.id] = { answers: picked };
      }
      vscode.postMessage({ type: 'userInputAnswer', requestId: msg.requestId, answers });
      card.classList.add('answered');
      card.querySelectorAll('button, input').forEach((el) => (el.disabled = true));
    }

    msg.questions.forEach((q, qIndex) => {
      const block = document.createElement('div');
      block.className = 'ui-question-block';

      const header = document.createElement('div');
      header.className = 'ui-header';
      const titleEl = document.createElement('div');
      titleEl.className = 'ui-title';
      titleEl.textContent = q.header || 'Question';
      header.appendChild(titleEl);
      if (qIndex === 0) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ui-close icon-btn';
        closeBtn.setAttribute('aria-label', 'Cancel');
        closeBtn.textContent = '×';
        closeBtn.onclick = cancel;
        header.appendChild(closeBtn);
      }
      block.appendChild(header);

      if (q.question) {
        const prompt = document.createElement('div');
        prompt.className = 'ui-prompt';
        prompt.textContent = q.question;
        block.appendChild(prompt);
      }

      const optionsEl = document.createElement('div');
      optionsEl.className = 'ui-options';
      const optionRows = [];

      function selectOption(label, rowEl) {
        state.get(q.id).selectedLabel = label;
        optionRows.forEach((r) => r.classList.remove('selected'));
        rowEl.classList.add('selected');
      }

      (q.options || []).forEach((opt) => {
        const row = document.createElement('div');
        row.className = 'ui-option';
        const labelEl = document.createElement('div');
        labelEl.className = 'ui-option-label';
        labelEl.textContent = opt.label;
        row.appendChild(labelEl);
        if (opt.description) {
          const descEl = document.createElement('div');
          descEl.className = 'ui-option-desc';
          descEl.textContent = opt.description;
          row.appendChild(descEl);
        }
        row.onclick = () => selectOption(opt.label, row);
        optionRows.push(row);
        optionsEl.appendChild(row);
      });

      if (q.isOther) {
        const otherRow = document.createElement('div');
        otherRow.className = 'ui-option ui-option-other';
        const otherLabel = document.createElement('div');
        otherLabel.className = 'ui-option-label';
        otherLabel.textContent = 'Other';
        otherRow.appendChild(otherLabel);
        const otherInput = document.createElement('input');
        otherInput.type = q.isSecret ? 'password' : 'text';
        otherInput.className = 'ui-other-input';
        otherInput.placeholder = 'Type your own answer…';
        otherInput.onclick = (e) => e.stopPropagation();
        otherInput.oninput = () => {
          state.get(q.id).otherText = otherInput.value;
          // Typing directly into the box (without first clicking the row --
          // stopPropagation() above means the row's own onclick never fires
          // for clicks landing on the input itself) must still count as
          // choosing "Other"; otherwise a submit right after typing would
          // silently send an empty answer for this question.
          selectOption('__other__', otherRow);
        };
        otherRow.onclick = () => {
          selectOption('__other__', otherRow);
          otherInput.focus();
        };
        otherRow.appendChild(otherInput);
        optionRows.push(otherRow);
        optionsEl.appendChild(otherRow);
      }

      block.appendChild(optionsEl);
      card.appendChild(block);
    });

    const footer = document.createElement('div');
    footer.className = 'ui-footer';
    const submitBtn = document.createElement('button');
    submitBtn.className = 'ui-submit';
    submitBtn.innerHTML = '<span class="ui-submit-num">1</span> Submit answers';
    submitBtn.onclick = submit;
    footer.appendChild(submitBtn);
    const hint = document.createElement('span');
    hint.className = 'ui-hint';
    hint.textContent = 'Esc to cancel';
    footer.appendChild(hint);
    card.appendChild(footer);

    keyHandler = (e) => {
      if (e.key === 'Escape') {
        cancel();
      }
    };
    document.addEventListener('keydown', keyHandler);

    appendEl(card);
  }

  function setTurnInProgress(inProgress) {
    sendBtn.classList.toggle('hidden', inProgress);
    stopBtn.classList.toggle('hidden', !inProgress);
  }

  // ── "Thinking..." indicator ──────────────────────────────────────────────
  const THINKING_WORDS = ['Thinking', 'Scheming', 'Pondering', 'Cooking', 'Percolating', 'Noodling', 'Investigating'];
  let thinkingTimer = null;

  function startThinking() {
    let i = 0;
    thinkingLabelEl.textContent = THINKING_WORDS[0] + '…';
    thinkingEl.classList.remove('hidden');
    clearInterval(thinkingTimer);
    thinkingTimer = setInterval(() => {
      i = (i + 1) % THINKING_WORDS.length;
      thinkingLabelEl.textContent = THINKING_WORDS[i] + '…';
    }, 2200);
  }

  function stopThinking() {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
    thinkingEl.classList.add('hidden');
  }

  function setWelcomeVisible(visible) {
    welcomeEl.classList.toggle('hidden', !visible);
    messagesEl.classList.toggle('hidden', visible);
    if (visible) {
      onboardingEl.classList.add('hidden');
    }
  }

  const ONBOARDING_CONTENT = {
    cliNotFound: {
      title: 'ByteAsk CLI not found',
      body: 'This extension drives the <code>byteask</code> command-line tool. Install it, then retry.',
      primaryLabel: 'Install ByteAsk',
      primaryMessage: 'installCli',
      manualSummary: 'Other ways to install',
    },
    notLoggedIn: {
      title: 'Not signed in to ByteAsk',
      body: "<code>byteask</code> is installed, but you're not signed in yet. Sign in, then retry.",
      primaryLabel: 'Log in',
      primaryMessage: 'login',
      manualSummary: 'Or run this in a terminal',
    },
  };

  /** Which onboarding variant is showing, if any -- read by the primary
   * button's click handler to decide whether to post 'installCli' or
   * 'login', since both variants share the same card/button DOM. */
  let onboardingMode = null;

  /** The onboarding card (CLI missing, or not logged in) takes over the
   * same slot as #welcome -- there's nothing useful to show in #messages
   * until the CLI is actually reachable and authenticated. */
  function setOnboardingVisible(visible, mode) {
    onboardingEl.classList.toggle('hidden', !visible);
    if (visible) {
      onboardingMode = mode;
      const content = ONBOARDING_CONTENT[mode];
      obTitleEl.textContent = content.title;
      obBodyEl.innerHTML = content.body;
      obPrimaryBtn.textContent = content.primaryLabel;
      obManualSummary.textContent = content.manualSummary;
      obManualInstall.classList.toggle('hidden', mode !== 'cliNotFound');
      obManualLogin.classList.toggle('hidden', mode !== 'notLoggedIn');
      welcomeEl.classList.add('hidden');
      messagesEl.classList.add('hidden');
    } else {
      onboardingMode = null;
      setWelcomeVisible(true);
    }
  }

  function clearThread() {
    messagesEl.innerHTML = ''; // also removes the spacer, if any
    itemEls.clear();
    itemText.clear();
    anchorMode = false;
    anchorBaselineBottom = 0;
    setTurnInProgress(false);
    stopThinking();
    setWelcomeVisible(true);
    titleSet = false;
    sessionTitleEl.textContent = 'New chat';
    closeHistoryPanel();
    scrollToBottom(); // reset stickToBottom for the next conversation
  }

  // ── History panel ──────────────────────────────────────────────────────

  function relativeTime(unixSeconds) {
    const diffMs = Date.now() - unixSeconds * 1000;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h';
    const days = Math.floor(hours / 24);
    return days + 'd';
  }

  function renderHistoryList(filterText) {
    historyList.innerHTML = '';
    const needle = (filterText || '').toLowerCase();
    const filtered = lastSessions.filter((s) => s.title.toLowerCase().includes(needle));
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = lastSessions.length === 0 ? 'No sessions found in ~/.byteask yet.' : 'No matches.';
      historyList.appendChild(empty);
      return;
    }
    for (const s of filtered) {
      const row = document.createElement('div');
      row.className = 'history-item';
      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = s.title;
      const time = document.createElement('span');
      time.className = 'history-time';
      time.textContent = relativeTime(s.updatedAt);
      row.appendChild(title);
      row.appendChild(time);
      row.addEventListener('click', () => {
        vscode.postMessage({ type: 'resumeThread', threadId: s.id });
        closeHistoryPanel();
      });
      historyList.appendChild(row);
    }
  }

  function openHistoryPanel() {
    historyPanel.classList.remove('hidden');
    historySearch.value = '';
    historySearch.focus();
    renderHistoryList('');
    vscode.postMessage({ type: 'listSessions' });
  }

  function closeHistoryPanel() {
    historyPanel.classList.add('hidden');
  }

  function toggleHistoryPanel() {
    if (historyPanel.classList.contains('hidden')) {
      openHistoryPanel();
    } else {
      closeHistoryPanel();
    }
  }

  function dispatch(msg) {
    switch (msg.type) {
      case 'userMessage':
        setWelcomeVisible(false);
        addUserMessage(msg.text);
        break;
      case 'itemStarted':
        // Don't stop on the userMessage item -- that's just the server
        // echoing the message we already showed eagerly on send, and it
        // fires almost immediately after turnStarted, which was killing the
        // thinking indicator before the model had done anything at all.
        if (msg.item.type !== 'userMessage') {
          stopThinking();
        }
        setWelcomeVisible(false);
        ensureItemEl(msg.item);
        break;
      case 'itemCompleted':
        if (msg.item.type !== 'userMessage') {
          stopThinking();
        }
        setWelcomeVisible(false);
        ensureItemEl(msg.item);
        finalizeItem(msg.item);
        break;
      case 'agentMessageDelta':
        stopThinking();
        appendDeltaToItem(msg.itemId, msg.delta, false);
        break;
      case 'reasoningDelta':
        stopThinking();
        appendDeltaToItem(msg.itemId, msg.delta, true);
        break;
      case 'turnStarted':
        setTurnInProgress(true);
        startThinking();
        break;
      case 'turnCompleted':
        setTurnInProgress(false);
        stopThinking();
        break;
      case 'error':
        stopThinking();
        setWelcomeVisible(false);
        addErrorMessage(msg.message);
        break;
      case 'cliNotFound':
        stopThinking();
        setOnboardingVisible(true, 'cliNotFound');
        break;
      case 'notLoggedIn':
        stopThinking();
        setOnboardingVisible(true, 'notLoggedIn');
        break;
      case 'connected':
        setOnboardingVisible(false);
        break;
      case 'systemMessage':
        setWelcomeVisible(false);
        addSystemMessage(msg.text);
        break;
      case 'approvalRequest':
        setWelcomeVisible(false);
        addApprovalCard(msg);
        break;
      case 'userInputRequest':
        stopThinking();
        setWelcomeVisible(false);
        addUserInputCard(msg);
        break;
      case 'cleared':
        clearThread();
        break;
      case 'sessionList':
        lastSessions = msg.sessions || [];
        renderHistoryList(historySearch.value);
        break;
      case 'attachmentAdded':
        pendingAttachment = { path: msg.path, name: msg.name, kind: msg.kind, content: msg.content };
        renderAttachmentChip();
        break;
      case 'insertText':
        insertAtCursor(msg.text);
        break;
      default:
        break;
    }
  }

  window.addEventListener('message', (event) => dispatch(event.data));

  // ── Attachments ("+" > Upload from computer) ──────────────────────────────
  function renderAttachmentChip() {
    attachmentsEl.innerHTML = '';
    if (!pendingAttachment) {
      return;
    }
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = (pendingAttachment.kind === 'image' ? '🖼 ' : '📄 ') + pendingAttachment.name;
    const remove = document.createElement('span');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.title = 'Remove';
    remove.addEventListener('click', () => {
      pendingAttachment = null;
      renderAttachmentChip();
    });
    chip.appendChild(name);
    chip.appendChild(remove);
    attachmentsEl.appendChild(chip);
  }

  function insertAtCursor(text) {
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? inputEl.value.length;
    const before = inputEl.value.slice(0, start);
    const after = inputEl.value.slice(end);
    const needsSpaceBefore = before.length > 0 && !/\s$/.test(before);
    const insert = (needsSpaceBefore ? ' ' : '') + text + ' ';
    inputEl.value = before + insert + after;
    const caret = (before + insert).length;
    inputEl.focus();
    inputEl.setSelectionRange(caret, caret);
  }

  function send() {
    const text = inputEl.value;
    if (text.trim() === '' && !pendingAttachment) {
      return;
    }
    vscode.postMessage({ type: 'sendMessage', text, attachment: pendingAttachment });
    inputEl.value = '';
    pendingAttachment = null;
    renderAttachmentChip();
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  historyBtn.addEventListener('click', toggleHistoryPanel);
  newChatBtn.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
  historySearch.addEventListener('input', () => renderHistoryList(historySearch.value));

  obPrimaryBtn.addEventListener('click', () => {
    const content = ONBOARDING_CONTENT[onboardingMode];
    if (content) {
      vscode.postMessage({ type: content.primaryMessage });
    }
  });
  obRetryBtn.addEventListener('click', () => vscode.postMessage({ type: 'retryConnect' }));
  onboardingEl.querySelectorAll('.ob-manual-cmd').forEach((el) => {
    el.addEventListener('click', () => {
      const text = el.getAttribute('data-copy') || el.textContent;
      navigator.clipboard.writeText(text).then(() => {
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 1200);
      });
    });
  });

  // File links in assistant messages (e.g. "Edited [hello.txt](/abs/path)")
  // are plain <a href> tags from the hand-rolled markdown renderer -- a
  // webview can't navigate to an arbitrary filesystem path, so without this
  // the link just silently does nothing. Intercept the click and ask the
  // extension to open it in a real editor tab instead.
  messagesEl.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) {
      return;
    }
    e.preventDefault();
    const href = link.getAttribute('href') || '';
    vscode.postMessage({ type: 'openFile', path: href });
  });

  // ── "+" and "/" popups (custom, anchored above the button -- see CSS
  // .popup-menu) ─────────────────────────────────────────────────────────
  function closeAllMenus() {
    plusMenu.classList.add('hidden');
    slashMenu.classList.add('hidden');
  }

  plusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !plusMenu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) {
      plusMenu.classList.remove('hidden');
    }
  });

  for (const item of plusMenu.querySelectorAll('.popup-item')) {
    item.addEventListener('click', () => {
      vscode.postMessage({ type: item.dataset.action });
      closeAllMenus();
    });
  }

  // Real byteask capabilities only (see TUI /status /usage /diff /skills
  // /logout /model /mention /clear) -- grouped like Claude's own "Filter
  // actions..." palette.
  const SLASH_ITEMS = [
    { section: 'Context', icon: '@', label: 'Mention file from this project...', action: 'mentionFile' },
    { section: 'Context', icon: '📄', label: 'Attach file...', action: 'uploadFile' },
    { section: 'Session', icon: '✕', label: 'Clear conversation', action: 'newThread' },
    { section: 'Session', icon: '◆', label: 'Switch model...', action: 'switchModel' },
    { section: 'Session', icon: 'i', label: 'Status', action: 'showStatus' },
    { section: 'Session', icon: '±', label: 'Usage', action: 'showUsage' },
    { section: 'Session', icon: '±', label: 'Diff', action: 'showDiff' },
    { section: 'Session', icon: '✨', label: 'Skills', action: 'showSkills' },
    { section: 'Account', icon: '→', label: 'Login', action: 'login' },
    { section: 'Account', icon: '←', label: 'Logout', action: 'logout' },
  ];

  function renderSlashList(filterText) {
    slashList.innerHTML = '';
    const needle = (filterText || '').toLowerCase();
    const filtered = SLASH_ITEMS.filter((it) => it.label.toLowerCase().includes(needle));
    let lastSection = null;
    for (const it of filtered) {
      if (it.section !== lastSection) {
        const label = document.createElement('div');
        label.className = 'popup-section-label';
        label.textContent = it.section;
        slashList.appendChild(label);
        lastSection = it.section;
      }
      const row = document.createElement('div');
      row.className = 'popup-item';
      row.innerHTML = `<span class="popup-item-icon">${it.icon}</span><span>${it.label}</span>`;
      row.addEventListener('click', () => {
        vscode.postMessage({ type: it.action });
        closeAllMenus();
      });
      slashList.appendChild(row);
    }
  }

  slashBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !slashMenu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) {
      slashMenu.classList.remove('hidden');
      slashSearch.value = '';
      renderSlashList('');
      slashSearch.focus();
    }
  });
  slashSearch.addEventListener('input', () => renderSlashList(slashSearch.value));
  // Item clicks already close the menu themselves (see renderSlashList);
  // this just stops whitespace/label clicks inside the popup from bubbling
  // to the document click-outside handler and closing it prematurely.
  slashMenu.addEventListener('click', (e) => e.stopPropagation());
  plusMenu.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') {
      return;
    }
    if (!historyPanel.classList.contains('hidden')) {
      closeHistoryPanel();
    }
    closeAllMenus();
  });
  document.addEventListener('click', (e) => {
    if (
      !historyPanel.classList.contains('hidden') &&
      !historyPanel.contains(e.target) &&
      e.target !== historyBtn &&
      !historyBtn.contains(e.target)
    ) {
      closeHistoryPanel();
    }
    closeAllMenus();
  });

  setWelcomeVisible(true);
  setTurnInProgress(false);
}());
