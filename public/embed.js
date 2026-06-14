(function () {
  const EMOJIS = [
    0x1f44d, 0x2764, 0x1f602, 0x1f389, 0x1f440, 0x1f680,
    0x1f60a, 0x1f64f, 0x1f525, 0x1f4af, 0x1f44f, 0x1f4a1,
    0x1f914, 0x1f92f, 0x2728, 0x1f929, 0x1f622, 0x1f621,
    0x1f60e, 0x1f64c, 0x1f4a5, 0x1f4ab, 0x1f3b5, 0x1f340
  ].map((code) => String.fromCodePoint(code));

  const script = document.currentScript;
  const targets = document.querySelectorAll("[data-zikiboard], #zikiboard");
  targets.forEach((target) => mount(target, script));

  function mount(root, currentScript) {
    var FETCH_TIMEOUT_MS = 15000;
    var MAX_REFRESH_RETRIES = 3;
    var refreshAttempt = 0;
    var currentAbort = null;

    const scriptUrl = currentScript ? new URL(currentScript.src, window.location.href) : new URL(window.location.href);
    const apiBase = root.dataset.apiBase || scriptUrl.origin;
    const blogId = root.dataset.blogId || `${window.location.host}${window.location.pathname}`;
    const state = {
      providers: [],
      user: null,
      comments: [],
      draft: "",
      composerMode: "write",
      replyTo: null,
      mentionQuery: null,
      mentionUsers: [],
      emojiOpen: false,
      error: "",
      busy: false,
      loading: true,
    };

    root.__zikiboardState = state;
    root.classList.add("zb");
    showLoading();
    refresh();

    function showLoading() {
      root.innerHTML =
        '<div class="zb-loading">' +
        '<div class="zb-loading-spinner"></div>' +
        '<div>Loading comments...</div>' +
        '</div>';
    }

    function showError(message) {
      root.innerHTML =
        '<div class="zb-error">' +
        '<div>' + escapeHtml(message || 'Failed to load comments') + '</div>' +
        '<button class="zb-retry-btn" type="button">Retry</button>' +
        '</div>';
      var retryBtn = root.querySelector('.zb-retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', function () {
          refreshAttempt = 0;
          state.loading = true;
          showLoading();
          refresh();
        });
      }
    }

    async function refresh() {
      state.error = "";
      state.loading = true;

      // Abort any in-flight requests from a previous refresh attempt
      if (currentAbort) {
        try { currentAbort.abort(); } catch (_) {}
      }
      currentAbort = new AbortController();
      var signal = currentAbort.signal;

      try {
        const [config, comments] = await Promise.all([
          api("/api/config", undefined, signal),
          api(`/api/blogs/${encodeURIComponent(blogId)}/comments`, undefined, signal),
        ]);
        state.providers = config.providers || [];
        state.user = config.user || null;
        state.comments = comments.comments || [];
        state.loading = false;
        refreshAttempt = 0;
        render();
      } catch (error) {
        if (signal.aborted) return; // Superseded by a newer refresh
        refreshAttempt++;
        if (refreshAttempt < MAX_REFRESH_RETRIES) {
          // Exponential back-off: 1s, 2s, 4s
          var delay = Math.pow(2, refreshAttempt - 1) * 1000;
          setTimeout(function () { refresh(); }, delay);
        } else {
          state.loading = false;
          state.error = messageFrom(error);
          showError(state.error);
        }
      }
    }

    function render() {
      root.innerHTML = "";
      root.append(header());
      root.append(composer());
      if (state.error) {
        const error = el("div", "zb-error", state.error);
        root.append(error);
      }
      if (!state.comments.length) {
        root.append(el("div", "zb-empty", "No comments yet."));
        return;
      }
      const list = el("ul", "zb-list");
      state.comments.forEach((comment) => list.append(commentNode(comment)));
      root.append(list);
    }

    function header() {
      const node = el("div", "zb-header");
      const titleWrap = el("div", "zb-title-wrap");
      titleWrap.append(el("h2", "zb-title", "Comments"));
      titleWrap.append(el("span", "zb-count", `${countComments(state.comments)} ${countComments(state.comments) === 1 ? "comment" : "comments"}`));
      node.append(titleWrap);
      const bar = el("div", "zb-userbar");
      if (state.user) {
        const userPill = el("span", "zb-current-user", state.user.displayName);
        bar.append(userPill);
        const logout = button("Log out", "zb-button", async () => {
          await api("/api/auth/logout", { method: "POST" });
          await refresh();
        });
        bar.append(logout);
      }
      node.append(bar);
      return node;
    }

    function composer() {
      const wrap = el("div", "zb-composer");
      if (!state.user) {
        const loginPanel = el("div", "zb-login-panel");
        const loginText = el("div", "zb-login-text");
        loginText.append(el("strong", "", "Sign in to join the discussion"));
        loginText.append(el("span", "", "Use your existing account to comment and reply."));
        loginPanel.append(loginText);

        const providers = el("div", "zb-login-actions");
        configuredProviders().forEach((provider) => providers.append(providerLoginButton(provider, "wide")));
        if (!providers.childNodes.length) {
          providers.append(el("span", "zb-login-copy", "No login provider configured."));
        }
        loginPanel.append(providers);
        wrap.append(loginPanel);
        return wrap;
      }

      if (state.replyTo) {
        const replyBar = el("div", "zb-replying");
        replyBar.append(el("span", "", `Replying to @${state.replyTo.author ? state.replyTo.author.handle : "comment"}`));
        replyBar.append(
          button("Cancel", "zb-link-button", () => {
            state.replyTo = null;
            render();
          }),
        );
        wrap.append(replyBar);
      }

      const file = document.createElement("input");
      file.type = "file";
      file.accept = "image/jpeg,image/png,image/gif,image/webp";
      file.className = "zb-file";

      let meta;
      let preview;
      const textarea = document.createElement("textarea");
      textarea.value = state.draft;
      textarea.placeholder = state.replyTo && state.replyTo.author ? `Leave a reply to @${state.replyTo.author.handle}` : "Leave a comment";
      textarea.addEventListener("input", () => {
        state.draft = textarea.value;
        if (meta) {
          meta.textContent = `${state.draft.length}/5000`;
        }
        if (preview && state.composerMode === "preview") {
          renderPreviewContent(preview, state.draft);
        }
        const query = activeMentionQuery(textarea.value, textarea.selectionStart);
        state.mentionQuery = query;
        if (query) {
          loadMentions(query).then(() => renderMentionPanel(wrap, textarea));
        } else {
          removeFloating();
        }
      });
      file.addEventListener("change", async () => {
        if (file.files && file.files[0]) {
          try {
            const uploaded = await upload(file.files[0]);
            appendToDraft(textarea, `\n![${escapeMarkdownAlt(file.files[0].name)}](${uploaded.url})\n`);
          } catch (error) {
            state.error = messageFrom(error);
            render();
          }
        }
      });

      const formatbar = el("div", "zb-formatbar");
      formatbar.append(file);
      formatbar.append(formatButton("<strong>B</strong>", "Bold", () => wrapSelection(textarea, "**", "**", "bold text")));
      formatbar.append(formatButton('<span class="zb-italic-icon">I</span>', "Italic", () => wrapSelection(textarea, "*", "*", "italic text")));
      formatbar.append(formatButton(linkIcon(), "Link", () => insertLink(textarea)));
      formatbar.append(formatButton("&lt;/&gt;", "Code", () => wrapSelection(textarea, "`", "`", "code")));
      formatbar.append(formatButton("&#8220;", "Quote", () => prefixSelectionLines(textarea, "> ")));
      formatbar.append(formatButton("&#8226;", "List", () => prefixSelectionLines(textarea, "- ")));
      formatbar.append(formatButton(imageIcon(), "Image", () => file.click()));
      formatbar.append(
        button(smileIcon(), "zb-icon-button zb-format-button", () => {
          state.emojiOpen = !state.emojiOpen;
          renderEmojiPanel(wrap, textarea);
        }, "Emoji"),
      );

      const editorShell = el("div", "zb-editor-shell");
      const editorHead = el("div", "zb-editor-head");
      const segments = el("div", "zb-segments");
      const writeButton = button("Write", "zb-segment", () => setComposerMode("write", editorShell, textarea, preview, writeButton, previewButton));
      const previewButton = button("Preview", "zb-segment", () => setComposerMode("preview", editorShell, textarea, preview, writeButton, previewButton));
      segments.setAttribute("role", "tablist");
      writeButton.setAttribute("role", "tab");
      previewButton.setAttribute("role", "tab");
      segments.append(writeButton, previewButton);
      editorHead.append(segments);
      editorShell.append(editorHead);

      const editorBody = el("div", "zb-editor-body");
      editorBody.append(textarea);
      preview = el("div", "zb-preview zb-markdown");
      editorBody.append(preview);
      editorShell.append(editorBody);
      setComposerMode(state.composerMode, editorShell, textarea, preview, writeButton, previewButton);

      const toolbar = el("div", "zb-toolbar");

      const right = el("div", "zb-actions");
      right.append(
        button(state.replyTo ? "Reply" : "Comment", "zb-button zb-button-primary", async () => {
          const content = state.draft.trim();
          if (!content || state.busy) {
            return;
          }
          state.busy = true;
          try {
            await api(`/api/blogs/${encodeURIComponent(blogId)}/comments`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                contentMarkdown: content,
                parentId: state.replyTo ? state.replyTo.id : null,
                imageUrls: extractImageUrls(content),
              }),
            });
            state.replyTo = null;
            state.draft = "";
            state.composerMode = "write";
            await refresh();
          } catch (error) {
            state.error = messageFrom(error);
            render();
          } finally {
            state.busy = false;
          }
        }),
      );
      meta = el("div", "zb-editor-meta", `${state.draft.length}/5000`);
      toolbar.append(meta);
      toolbar.append(right);
      const editorFooter = el("div", "zb-editor-footer");
      editorFooter.append(formatbar);
      editorFooter.append(toolbar);
      editorShell.append(editorFooter);
      wrap.append(editorShell);
      return wrap;
    }

    function configuredProviders() {
      return state.providers.filter((provider) => provider.configured);
    }

    function providerLoginButton(provider, variant) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = `zb-provider zb-provider-${providerKey(provider)} zb-provider-${variant}`;
      node.innerHTML = `${providerIcon(provider)}<span class="zb-provider-label"><span>${escapeHtml(provider.name)}</span>${variant === "wide" ? `<small>Continue with ${escapeHtml(provider.name)}</small>` : ""}</span>`;
      node.addEventListener("click", () => {
        const redirect = encodeURIComponent(window.location.href);
        window.location.href = `${apiBase}/api/auth/login/${encodeURIComponent(provider.id)}?redirect=${redirect}`;
      });
      return node;
    }

    function commentNode(comment) {
      const item = el("li", "zb-comment");
      if (comment.deleted) {
        item.append(el("div", "zb-handle", "Deleted comment"));
      } else {
        const head = el("div", "zb-comment-head");
        if (comment.author.avatarUrl) {
          const img = document.createElement("img");
          img.className = "zb-avatar";
          img.src = comment.author.avatarUrl;
          img.alt = "";
          head.append(img);
        } else {
          head.append(el("div", "zb-avatar"));
        }
        head.append(el("span", "zb-author", comment.author.displayName));
        head.append(el("span", "zb-handle", `@${comment.author.handle}`));
        head.append(el("span", "zb-time", relativeTime(comment.createdAt)));
        item.append(head);
        const body = el("div", "zb-markdown");
        body.innerHTML = renderMarkdown(comment.contentMarkdown);
        item.append(body);
      }

      const reactions = el("div", "zb-reactions");
      EMOJIS.forEach((emoji) => {
        const existing = (comment.reactions || []).find((reaction) => reaction.emoji === emoji);
        const reaction = button(
          `${emoji} ${existing ? existing.count : ""}`,
          `zb-reaction ${existing && existing.reacted ? "zb-reaction-active" : ""}`,
          async () => {
            try {
              await api(`/api/comments/${encodeURIComponent(comment.id)}/reactions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ emoji }),
              });
              await refresh();
            } catch (error) {
              state.error = messageFrom(error);
              render();
            }
          },
          `React ${emoji}`,
        );
        reactions.append(reaction);
      });
      if (state.user && !comment.deleted) {
        reactions.append(
          button("Reply", "zb-reply", () => {
            state.replyTo = comment;
            render();
          }),
        );
      }
      item.append(reactions);

      if (comment.replies && comment.replies.length) {
        const replies = el("ul", "zb-list");
        comment.replies.forEach((reply) => replies.append(commentNode(reply)));
        item.append(replies);
      }
      return item;
    }

    async function loadMentions(query) {
      try {
        const data = await api(`/api/blogs/${encodeURIComponent(blogId)}/mentions?q=${encodeURIComponent(query)}`);
        state.mentionUsers = data.users || [];
      } catch {
        state.mentionUsers = [];
      }
    }

    function renderMentionPanel(parent, textarea) {
      removeFloating();
      if (!state.mentionUsers.length) {
        return;
      }
      const panel = el("div", "zb-mentions");
      state.mentionUsers.forEach((user) => {
        panel.append(
          button(`@${user.handle} ${user.displayName}`, "", () => {
            textarea.value = replaceActiveMention(textarea.value, textarea.selectionStart, user.handle);
            textarea.focus();
            removeFloating();
          }),
        );
      });
      parent.append(panel);
    }

    function renderEmojiPanel(parent, textarea) {
      removeFloating();
      if (!state.emojiOpen) {
        return;
      }
      const panel = el("div", "zb-emoji-panel");
      EMOJIS.forEach((emoji) => {
        panel.append(
          button(emoji, "", () => {
            insertAt(textarea, emoji);
            state.emojiOpen = false;
            removeFloating();
          }),
        );
      });
      parent.append(panel);
    }

    function removeFloating() {
      root.querySelectorAll(".zb-emoji-panel,.zb-mentions").forEach((node) => node.remove());
    }

    async function api(path, options, signal) {
      // Use AbortSignal.timeout when available, otherwise fall back to
      // a manual AbortController that fires after FETCH_TIMEOUT_MS.
      var timeoutSignal;
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      }

      // Combine the caller's abort signal with the timeout signal
      var combinedSignal;
      if (signal && timeoutSignal) {
        var combined = new AbortController();
        signal.addEventListener('abort', function () { combined.abort(signal.reason); });
        timeoutSignal.addEventListener('abort', function () { combined.abort(timeoutSignal.reason); });
        combinedSignal = combined.signal;
      } else {
        combinedSignal = signal || timeoutSignal || undefined;
      }

      var response;
      try {
        response = await fetch(`${apiBase}${path}`, {
          credentials: "include",
          signal: combinedSignal,
          ...options,
        });
      } catch (fetchError) {
        if (fetchError && fetchError.name === 'AbortError') {
          throw new Error('Request timed out');
        }
        throw new Error('Network error');
      }
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json") ? await response.json() : null;
      if (!response.ok) {
        throw new Error((data && data.error && data.error.message) || `Request failed: ${response.status}`);
      }
      return data;
    }

    async function upload(file) {
      const body = new FormData();
      body.set("file", file);
      return api("/api/uploads/images", { method: "POST", body });
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function button(label, className, onClick, title) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className || "";
    node.innerHTML = label;
    if (title) {
      node.title = title;
      node.setAttribute("aria-label", title);
    }
    node.addEventListener("click", onClick);
    return node;
  }

  function formatButton(label, title, onClick) {
    return button(label, "zb-icon-button zb-format-button", onClick, title);
  }

  function providerKey(provider) {
    const key = `${provider.id || ""} ${provider.name || ""} ${provider.type || ""}`.toLowerCase();
    if (key.includes("google")) {
      return "google";
    }
    if (key.includes("github")) {
      return "github";
    }
    return "generic";
  }

  function providerIcon(provider) {
    const key = providerKey(provider);
    if (key === "google") {
      return '<span class="zb-provider-icon" aria-hidden="true"><svg viewBox="0 0 18 18" focusable="false"><path fill="#4285f4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34a853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.72H.94v2.33A9 9 0 0 0 9 18Z"/><path fill="#fbbc05" d="M3.96 10.7A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.16.28-1.7V4.97H.94A9 9 0 0 0 0 9c0 1.45.34 2.82.94 4.03l3.02-2.33Z"/><path fill="#ea4335" d="M9 3.58c1.32 0 2.5.45 3.43 1.35l2.6-2.6A8.7 8.7 0 0 0 9 0 9 9 0 0 0 .94 4.97L3.96 7.3C4.67 5.16 6.66 3.58 9 3.58Z"/></svg></span>';
    }
    if (key === "github") {
      return '<span class="zb-provider-icon" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path fill="currentColor" d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.49-2.7-1.08-2.7-1.08-.37-.93-.9-1.18-.9-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.34.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.9-3.65-3.96 0-.88.31-1.6.82-2.16-.08-.2-.36-1.03.08-2.13 0 0 .68-.22 2.2.82A7.65 7.65 0 0 1 8 3.73c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.93.08 2.13.52.56.82 1.28.82 2.16 0 3.07-1.87 3.75-3.66 3.95.29.25.55.74.55 1.5v2.22c0 .21.14.46.55.38A8 8 0 0 0 8 .2Z"/></svg></span>';
    }
    return '<span class="zb-provider-icon" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M8 8.25A3.1 3.1 0 1 0 8 2a3.1 3.1 0 0 0 0 6.25Zm5.25 6.15c-.54-2.25-2.56-3.9-5.25-3.9s-4.71 1.65-5.25 3.9"/></svg></span>';
  }

  function linkIcon() {
    return '<svg class="zb-format-svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6.5 4.75 3.75 7.5a2.12 2.12 0 0 0 3 3L8 9.25m1.5 2 2.75-2.75a2.12 2.12 0 0 0-3-3L8 6.75"/></svg>';
  }

  function imageIcon() {
    return '<svg class="zb-format-svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.75" y="3" width="10.5" height="10" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m4.6 11 2.3-2.4 1.7 1.6 1.4-1.5 1.4 2.3"/><circle cx="6" cy="6.1" r=".75" fill="currentColor"/></svg>';
  }

  function smileIcon() {
    return '<svg class="zb-format-svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6.1" cy="6.7" r=".65" fill="currentColor"/><circle cx="9.9" cy="6.7" r=".65" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M5.7 9.4c.48.75 1.23 1.1 2.3 1.1s1.82-.35 2.3-1.1"/></svg>';
  }

  function setComposerMode(mode, shell, textarea, preview, writeButton, previewButton) {
    stateSafeSetMode(shell, mode);
    if (mode === "preview") {
      renderPreviewContent(preview, stateValue(textarea));
    }
    textarea.hidden = mode !== "write";
    preview.hidden = mode !== "preview";
    writeButton.classList.toggle("zb-segment-active", mode === "write");
    previewButton.classList.toggle("zb-segment-active", mode === "preview");
    writeButton.setAttribute("aria-pressed", String(mode === "write"));
    previewButton.setAttribute("aria-pressed", String(mode === "preview"));
    writeButton.setAttribute("aria-selected", String(mode === "write"));
    previewButton.setAttribute("aria-selected", String(mode === "preview"));
  }

  function stateSafeSetMode(shell, mode) {
    shell.dataset.mode = mode;
    const widget = shell.closest(".zb");
    if (widget && widget.__zikiboardState) {
      widget.__zikiboardState.composerMode = mode;
    }
  }

  function stateValue(textarea) {
    return textarea.value;
  }

  function renderPreviewContent(preview, markdown) {
    preview.innerHTML = markdown.trim()
      ? renderMarkdown(markdown)
      : '<p class="zb-preview-empty">Nothing to preview.</p>';
  }

  function wrapSelection(textarea, before, after, placeholder) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end) || placeholder;
    replaceRange(textarea, start, end, `${before}${selected}${after}`);
  }

  function insertLink(textarea) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end) || "link text";
    replaceRange(textarea, start, end, `[${selected}](https://)`);
  }

  function prefixSelectionLines(textarea, prefix) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end) || "";
    const replacement = selected
      ? selected.split("\n").map((line) => `${prefix}${line}`).join("\n")
      : `${prefix}`;
    replaceRange(textarea, start, end, replacement);
  }

  function replaceRange(textarea, start, end, value) {
    textarea.focus();
    textarea.setRangeText(value, start, end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function appendToDraft(textarea, value) {
    textarea.value += value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function renderMarkdown(markdown) {
    let html = escapeHtml(markdown);
    html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/media\/[^)\s]+)\)/g, function (_, alt, url) {
      return `<img src="${url}" alt="${alt}">`;
    });
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="nofollow noopener" target="_blank">$1</a>');
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/(^|\s)@([a-zA-Z0-9_-]{3,32})/g, '$1<span class="zb-mention">@$2</span>');

    html = html.replace(/^[ \t]*[-*][ \t]+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/(?:<li>.*?<\/li>(?:\r?\n)?)+/g, (match) => `<ul>${match.replace(/\r?\n/g, "")}</ul>`);

    return html
      .split(/\n{2,}/)
      .map((paragraph) => {
        if (paragraph.startsWith("<ul>") && paragraph.endsWith("</ul>")) {
          return paragraph;
        }
        return `<p>${paragraph.replace(/\n/g, "<br>")}</p>`;
      })
      .join("");
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    });
  }

  function escapeMarkdownAlt(value) {
    return value.replace(/[[\]()]/g, "").slice(0, 80);
  }

  function extractImageUrls(markdown) {
    return Array.from(markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g), function (match) {
      return match[1];
    });
  }

  function activeMentionQuery(value, cursor) {
    const before = value.slice(0, cursor);
    const match = before.match(/(^|\s)@([a-zA-Z0-9_-]{1,32})$/);
    return match ? match[2] : null;
  }

  function replaceActiveMention(value, cursor, handle) {
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    return before.replace(/(^|\s)@([a-zA-Z0-9_-]{1,32})$/, `$1@${handle} `) + after;
  }

  function insertAt(textarea, value) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, start) + value + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + value.length;
    textarea.focus();
  }

  function relativeTime(iso) {
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) {
      return "just now";
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function messageFrom(error) {
    return error && error.message ? error.message : "Request failed";
  }

  function countComments(comments) {
    return comments.reduce((total, comment) => total + 1 + countComments(comment.replies || []), 0);
  }
})();
