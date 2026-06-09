(function () {
  const EMOJIS = [0x1f44d, 0x2764, 0x1f602, 0x1f389, 0x1f440, 0x1f680].map((code) =>
    String.fromCodePoint(code),
  );

  const script = document.currentScript;
  const targets = document.querySelectorAll("[data-zikiboard], #zikiboard");
  targets.forEach((target) => mount(target, script));

  function mount(root, currentScript) {
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
    };

    root.__zikiboardState = state;
    root.classList.add("zb");
    refresh();

    async function refresh() {
      state.error = "";
      try {
        const [config, comments] = await Promise.all([
          api("/api/config"),
          api(`/api/blogs/${encodeURIComponent(blogId)}/comments`),
        ]);
        state.providers = config.providers || [];
        state.user = config.user || null;
        state.comments = comments.comments || [];
      } catch (error) {
        state.error = messageFrom(error);
      }
      render();
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
      } else {
        const providers = el("div", "zb-provider-list");
        state.providers.forEach((provider) => {
          if (!provider.configured) {
            return;
          }
          providers.append(
            button(provider.name, "zb-provider", () => {
              const redirect = encodeURIComponent(window.location.href);
              window.location.href = `${apiBase}/api/auth/login/${encodeURIComponent(provider.id)}?redirect=${redirect}`;
            }),
          );
        });
        if (!providers.childNodes.length) {
          providers.append(el("span", "zb-login-copy", "No login provider configured."));
        }
        bar.append(providers);
      }
      node.append(bar);
      return node;
    }

    function composer() {
      const wrap = el("div", "zb-composer");
      if (!state.user) {
        wrap.append(el("p", "zb-login-copy", "Sign in to join the discussion."));
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
      textarea.placeholder = state.replyTo && state.replyTo.author ? `Reply to @${state.replyTo.author.handle}` : "Write a comment";
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
      formatbar.append(formatButton("B", "Bold", () => wrapSelection(textarea, "**", "**", "bold text")));
      formatbar.append(formatButton("<i>I</i>", "Italic", () => wrapSelection(textarea, "*", "*", "italic text")));
      formatbar.append(formatButton("&#128279;", "Link", () => insertLink(textarea)));
      formatbar.append(formatButton("&lt;/&gt;", "Code", () => wrapSelection(textarea, "`", "`", "code")));
      formatbar.append(formatButton("&#8220;", "Quote", () => prefixSelectionLines(textarea, "> ")));
      formatbar.append(formatButton("&#8226;", "List", () => prefixSelectionLines(textarea, "- ")));
      formatbar.append(formatButton("&#128247;", "Image", () => file.click()));
      formatbar.append(
        button("&#128522;", "zb-icon-button", () => {
          state.emojiOpen = !state.emojiOpen;
          renderEmojiPanel(wrap, textarea);
        }, "Emoji"),
      );
      wrap.append(formatbar);

      const editorHead = el("div", "zb-editor-head");
      const segments = el("div", "zb-segments");
      const writeButton = button("Write", "zb-segment", () => setComposerMode("write", editorShell, textarea, preview, writeButton, previewButton));
      const previewButton = button("Preview", "zb-segment", () => setComposerMode("preview", editorShell, textarea, preview, writeButton, previewButton));
      segments.append(writeButton, previewButton);
      editorHead.append(segments);
      wrap.append(editorHead);

      const editorShell = el("div", "zb-editor-shell");
      editorShell.append(textarea);
      preview = el("div", "zb-preview zb-markdown");
      editorShell.append(preview);
      wrap.append(editorShell);
      setComposerMode(state.composerMode, editorShell, textarea, preview, writeButton, previewButton);

      const toolbar = el("div", "zb-toolbar");

      const right = el("div", "zb-actions");
      right.append(
        button("Post", "zb-button zb-button-primary", async () => {
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
      wrap.append(toolbar);
      return wrap;
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

    async function api(path, options) {
      const response = await fetch(`${apiBase}${path}`, {
        credentials: "include",
        ...options,
      });
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

  function setComposerMode(mode, shell, textarea, preview, writeButton, previewButton) {
    stateSafeSetMode(shell, mode);
    if (mode === "preview") {
      renderPreviewContent(preview, stateValue(textarea));
    }
    textarea.hidden = mode !== "write";
    preview.hidden = mode !== "preview";
    writeButton.classList.toggle("zb-segment-active", mode === "write");
    previewButton.classList.toggle("zb-segment-active", mode === "preview");
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
    return html
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
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
