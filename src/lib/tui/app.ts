import { BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable, TextRenderable, TextAttributes, createCliRenderer } from '@opentui/core';
import type { CliRenderer } from '@opentui/core';
import type { SlackClient } from '../slack-client.ts';
import type { SlackChannel, SlackMessage, SlackUser } from '../../types/index.ts';
import { writeClipboard } from '../clipboard.ts';

const USER_COLORS = ['#7DD3FC', '#F9A8D4', '#86EFAC', '#FCD34D', '#C4B5FD', '#FDBA74', '#67E8F9', '#FCA5A5'];

const state = {
  workspaceLabel: '',
  imChannels: [] as SlackChannel[],
  privateChannels: [] as SlackChannel[],
  selectedId: '',
  selectedChannel: null as SlackChannel | null,
  messages: [] as SlackMessage[],
  users: new Map<string, SlackUser>(),
  status: 'Loading...',
  selectedMessageIdx: -1,
  threadView: null as { channelId: string; threadTs: string; parentMessage: SlackMessage } | null,
};

const userDisplayName = (userId: string) => state.users.get(userId)?.real_name || state.users.get(userId)?.name || userId;

const channelLabel = (channel: SlackChannel) => {
  if (channel.is_im && channel.user) return `@${userDisplayName(channel.user)}`;
  if (channel.is_mpim) return channel.name || 'Group DM';
  return `#${channel.name || channel.id}`;
};

const cleanSlackText = (raw: string): string => {
  return raw
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, '@$1')
    .replace(/<!channel>/gi, '@channel')
    .replace(/<!here>/gi, '@here')
    .replace(/<!everyone>/gi, '@everyone')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~([^~]+)~/g, '$1');
};

const extractBlockText = (blocks: Array<Record<string, unknown>> | undefined): string => {
  if (!blocks?.length) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'rich_text') {
      const elements = (block as any).elements || [];
      for (const section of elements) {
        if (section.type === 'rich_text_section') {
          for (const el of section.elements || []) {
            if (el.type === 'text') parts.push(el.text);
            if (el.type === 'user') parts.push(`@${el.user_id || 'user'}`);
            if (el.type === 'channel') parts.push(`#${el.channel_id || 'channel'}`);
            if (el.type === 'link') parts.push(el.url || '');
            if (el.type === 'emoji') parts.push(`:${el.name}:`);
            if (el.type === 'broadcast') parts.push(`@${el.range}`);
          }
        }
      }
    }
    if (block.type === 'section') {
      const t = (block as any).text;
      if (t?.text) parts.push(t.text);
    }
    if (block.type === 'context') {
      for (const el of (block as any).elements || []) {
        if (el.text) parts.push(el.text);
      }
    }
  }
  return parts.join(' ');
};

const removeChildren = (parent: BoxRenderable | ScrollBoxRenderable) => {
  for (const child of parent.getChildren()) {
    try { child.destroy(); } catch {}
    try { parent.remove(child.id); } catch {}
  }
};

const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

const userColor = (msg: SlackMessage): string => {
  const key = msg.user || msg.bot_id || 'unknown';
  return USER_COLORS[hashString(key) % USER_COLORS.length];
};

interface TextSegment {
  type: 'text' | 'code';
  content: string;
}

const parseSegments = (raw: string): TextSegment[] => {
  const segments: TextSegment[] = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: raw.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', content: match[2].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < raw.length) {
    segments.push({ type: 'text', content: raw.slice(lastIndex) });
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', content: raw });
  }

  return segments;
};

const wrapLine = (line: string, width: number): string[] => {
  if (!line) return [''];
  if (line.length <= width) return [line];
  const wrapped: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const slice = remaining.slice(0, width + 1);
    const breakAt = slice.lastIndexOf(' ');
    const cut = breakAt > Math.floor(width / 2) ? breakAt : width;
    wrapped.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) wrapped.push(remaining);
  return wrapped;
};

const wrapText = (text: string, width: number): string[] => {
  const lines = text.split('\n');
  return lines.flatMap((line) => wrapLine(line, width));
};

const shortTimestamp = (ts: string): string => {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
};

const renderMessages = (renderer: CliRenderer, messageBox: BoxRenderable, messageScroll: ScrollBoxRenderable, selectedIdx: number) => {
  removeChildren(messageBox);
  const threadView = state.threadView;
  const isThreadMode = !!threadView;

  if (threadView) {
    const parent = threadView.parentMessage;
    const parentName = parent.user ? userDisplayName(parent.user) : parent.bot_id || 'Unknown';
    const parentText = cleanSlackText(parent.text || extractBlockText(parent.blocks) || '') || '';
    const header = new BoxRenderable(renderer, {
      id: 'thread-header',
      width: '100%',
      height: 2,
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: '#14B8A6',
      paddingX: 1,
      marginBottom: 1,
    });
    header.add(new TextRenderable(renderer, { id: 'thread-label', content: 'Thread', fg: '#2DD4BF', attributes: TextAttributes.BOLD }));
    header.add(new TextRenderable(renderer, { id: 'thread-parent', content: `${parentName}: ${parentText}`, fg: '#9CA3AF' }));
    messageBox.add(header);
  }

  if (state.messages.length === 0) {
    messageBox.add(new TextRenderable(renderer, { id: 'empty', content: 'No messages yet.', fg: '#888888' }));
    return;
  }

  const contentWidth = Math.max(24, messageScroll.width - 8);

  state.messages.forEach((msg, idx) => {
    const userName = msg.user ? userDisplayName(msg.user) : msg.bot_id || 'Unknown';
    const timestamp = shortTimestamp(msg.ts);
    const text = cleanSlackText(msg.text || extractBlockText(msg.blocks) || '') || '[no text]';
    const segs = parseSegments(text);
    const segLines = segs.map(s => ({ type: s.type, lines: wrapText(s.content, contentWidth) }));
    const totalBodyLines = segLines.reduce((sum, s) => sum + s.lines.length, 0);
    const hasThread = !!msg.reply_count && !isThreadMode;
    const reactionLine = msg.reactions && msg.reactions.length > 0
      ? `  ${msg.reactions.map(r => `${r.name} ${r.count}`).join('  ')}`
      : null;
    const replyLine = hasThread ? `  ${msg.reply_count} replies  Ctrl+Enter to open` : null;
    const extraLines = (reactionLine ? 1 : 0) + (replyLine ? 1 : 0);
    const rowHeight = 1 + totalBodyLines + extraLines + 2;
    const isSelected = idx === selectedIdx;
    const ident = `${idx}-${msg.ts.replace('.', '-')}`;

    const row = new BoxRenderable(renderer, {
      id: `msg-row-${ident}`,
      width: '100%',
      height: rowHeight,
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: isSelected
        ? (isThreadMode ? '#14B8A6' : '#6366F1')
        : (isThreadMode ? '#0F766E' : '#374151'),
      backgroundColor: isSelected
        ? (isThreadMode ? '#115E59' : '#1E293B')
        : (isThreadMode ? '#042F2E' : undefined),
      paddingX: 1,
      paddingY: 0,
      marginBottom: 1,
    });

    const header = new BoxRenderable(renderer, {
      id: `msg-header-${ident}`,
      width: '100%',
      height: 1,
      flexDirection: 'row',
      justifyContent: 'space-between',
    });
    header.add(new TextRenderable(renderer, { id: `msg-user-${ident}`, content: userName, fg: userColor(msg), attributes: TextAttributes.BOLD }));
    header.add(new TextRenderable(renderer, { id: `msg-ts-${ident}`, content: timestamp, fg: '#6B7280' }));
    row.add(header);

    segLines.forEach((seg, segIdx) => {
      row.add(new TextRenderable(renderer, {
        id: `msg-seg-${ident}-${segIdx}`,
        content: seg.lines.join('\n'),
        width: '100%',
        height: seg.lines.length,
        fg: seg.type === 'code' ? '#A5F3FC' : '#E5E7EB',
      }));
    });

    if (reactionLine) {
      row.add(new TextRenderable(renderer, { id: `msg-react-${ident}`, content: reactionLine, width: '100%', height: 1, fg: '#9CA3AF' }));
    }

    if (replyLine) {
      row.add(new TextRenderable(renderer, { id: `msg-reply-${ident}`, content: replyLine, width: '100%', height: 1, fg: '#93C5FD' }));
    }

    messageBox.add(row);
  });
};

const frameGate = (renderer: CliRenderer) =>
  new Promise<void>((resolve) => { renderer.once('frame', () => resolve()); renderer.requestRender(); });

const scrollToBottom = async (renderer: CliRenderer, messageBox: BoxRenderable, messageScroll: ScrollBoxRenderable) => {
  await frameGate(renderer);
  const children = messageBox.getChildren();
  if (children.length > 0) {
    messageScroll.scrollChildIntoView(children[children.length - 1].id);
  } else {
    messageScroll.scrollTo({ x: 0, y: 0 });
  }
  renderer.requestRender();
};

const scrollChildIntoView = async (renderer: CliRenderer, messageScroll: ScrollBoxRenderable, childId: string) => {
  await frameGate(renderer);
  messageScroll.scrollChildIntoView(childId);
  renderer.requestRender();
};

const renderStatus = (statusBar: TextRenderable) => {
  const parts = [state.workspaceLabel, state.selectedChannel ? channelLabel(state.selectedChannel) : '', state.status].filter(Boolean);
  statusBar.content = parts.join(' | ');
};

const loadConversations = async (renderer: CliRenderer, client: SlackClient, imSelect: SelectRenderable, privateSelect: SelectRenderable, statusBar: TextRenderable, types: string, limit: number) => {
  state.status = 'Loading conversations...';
  renderStatus(statusBar);
  const response = await client.listConversations({ types, limit, exclude_archived: true });
  const channels: SlackChannel[] = response.channels || [];
  const userIds = new Set<string>();
  channels.forEach(ch => { if (ch.is_im && ch.user) userIds.add(ch.user); });
  if (userIds.size > 0) {
    const usersResponse = await client.getUsersInfo(Array.from(userIds));
    usersResponse.users?.forEach((user: SlackUser) => state.users.set(user.id, user));
  }
  state.imChannels = channels.filter(ch => ch.is_im);
  state.privateChannels = channels.filter(ch => ch.is_private || ch.is_mpim || ch.is_group);
  imSelect.options = state.imChannels.map(ch => ({ name: channelLabel(ch), description: ch.id }));
  privateSelect.options = state.privateChannels.map(ch => ({ name: channelLabel(ch), description: ch.id }));
  if (state.imChannels.length > 0) {
    imSelect.setSelectedIndex(0);
    state.selectedChannel = state.imChannels[0];
  } else if (state.privateChannels.length > 0) {
    privateSelect.setSelectedIndex(0);
    state.selectedChannel = state.privateChannels[0];
  }
  state.selectedId = state.selectedChannel?.id || '';
  state.status = 'Conversations loaded.';
  renderStatus(statusBar);
};

const loadMessages = async (renderer: CliRenderer, client: SlackClient, channelId: string, messageBox: BoxRenderable, messageScroll: ScrollBoxRenderable, statusBar: TextRenderable, limit: number) => {
  state.status = 'Loading messages...';
  renderStatus(statusBar);
  state.threadView = null;
  state.selectedMessageIdx = -1;
  const response = await client.getConversationHistory(channelId, { limit });
  state.messages = (response.messages || []).reverse();
  renderMessages(renderer, messageBox, messageScroll, -1);
  await scrollToBottom(renderer, messageBox, messageScroll);
  state.status = 'Messages loaded.';
  renderStatus(statusBar);
};

const sendMessage = async (renderer: CliRenderer, client: SlackClient, channelId: string, text: string, composer: InputRenderable, messageBox: BoxRenderable, messageScroll: ScrollBoxRenderable, statusBar: TextRenderable) => {
  const trimmed = text.trim();
  if (!trimmed) {
    state.status = 'Enter a message before sending.';
    renderStatus(statusBar);
    return;
  }
  state.status = 'Sending...';
  renderStatus(statusBar);
  await client.postMessage(channelId, trimmed);
  composer.value = '';
  await loadMessages(renderer, client, channelId, messageBox, messageScroll, statusBar, 100);
};

const openThread = async (renderer: CliRenderer, client: SlackClient, msg: SlackMessage, messageBox: BoxRenderable, messageScroll: ScrollBoxRenderable, statusBar: TextRenderable) => {
  const threadTs = msg.thread_ts || msg.ts;
  state.status = 'Loading thread...';
  renderStatus(statusBar);
  state.threadView = { channelId: state.selectedId, threadTs, parentMessage: msg };
  state.selectedMessageIdx = -1;
  const response = await client.getConversationReplies(state.selectedId, threadTs, { limit: 100 });
  state.messages = response.messages || [];
  renderMessages(renderer, messageBox, messageScroll, -1);
  await scrollToBottom(renderer, messageBox, messageScroll);
  state.status = `Thread (${state.messages.length} messages)`;
  renderStatus(statusBar);
};

const closeThread = async (renderer: CliRenderer, client: SlackClient, messageBox: BoxRenderable, messageScroll: ScrollBoxRenderable, statusBar: TextRenderable) => {
  state.threadView = null;
  state.selectedMessageIdx = -1;
  await loadMessages(renderer, client, state.selectedId, messageBox, messageScroll, statusBar, 100);
};

const selectChannel = async (channel: SlackChannel | undefined, renderer: CliRenderer, client: SlackClient, messageBox: BoxRenderable, messageScroll: ScrollBoxRenderable, composer: InputRenderable, statusBar: TextRenderable, limit: number) => {
  if (!channel) return;
  state.selectedChannel = channel;
  state.selectedId = channel.id;
  state.threadView = null;
  state.selectedMessageIdx = -1;
  renderStatus(statusBar);
  await loadMessages(renderer, client, channel.id, messageBox, messageScroll, statusBar, limit);
  messageScroll.focus();
};

export async function runSlackTui(client: SlackClient, options: { workspaceLabel: string; types: string; limit: number; channel?: string }) {
  const renderer: CliRenderer = await createCliRenderer({ exitOnCtrlC: true });

  state.workspaceLabel = options.workspaceLabel;
  state.status = 'Starting...';

  const statusBar = new TextRenderable(renderer, { id: 'status', content: state.workspaceLabel, fg: '#FFFFFF' });
  const header = new BoxRenderable(renderer, { id: 'header', flexDirection: 'row', width: '100%', height: 1, paddingX: 1, backgroundColor: '#1F2937' });
  header.add(statusBar);

  const messageBox = new BoxRenderable(renderer, { id: 'msgs', flexDirection: 'column', width: '100%' });
  const messageScroll = new ScrollBoxRenderable(renderer, { id: 'scroll', width: '100%', height: '100%', stickyScroll: true, stickyStart: 'bottom', scrollY: true, viewportCulling: true, focusable: true });
  messageScroll.add(messageBox);

  const composer = new InputRenderable(renderer, { id: 'composer', placeholder: 'Type a message and press Enter...', width: '100%' });

  const label = (text: string) => new TextRenderable(renderer, { id: `lbl-${text.replace(/\s+/g, '-').toLowerCase()}`, content: text, fg: '#888888' });

  const imTitle = label('Direct Messages');
  const imSelect = new SelectRenderable(renderer, { id: 'im-select', width: '100%', height: 8, options: [] });
  const privateTitle = label('Private Channels');
  const privateSelect = new SelectRenderable(renderer, { id: 'priv-select', width: '100%', height: 8, options: [] });

  const conversationPanel = new BoxRenderable(renderer, {
    id: 'left', flexDirection: 'column', flexGrow: 0, width: 30, height: '100%', padding: 1,
    border: true, borderStyle: 'rounded', borderColor: '#374151',
  });
  conversationPanel.add(new TextRenderable(renderer, { id: 'conv-title', content: 'Conversations', fg: '#FACC15' }));
  conversationPanel.add(imTitle);
  conversationPanel.add(imSelect);
  conversationPanel.add(privateTitle);
  conversationPanel.add(privateSelect);

  const messagePanel = new BoxRenderable(renderer, {
    id: 'msg-panel', flexDirection: 'column', flexGrow: 1, padding: 1,
    border: true, borderStyle: 'rounded', borderColor: '#374151',
  });
  messagePanel.add(messageScroll);

  const composerPanel = new BoxRenderable(renderer, {
    id: 'comp-panel', flexDirection: 'column', flexGrow: 0, width: '100%', height: 3, padding: 1,
    border: true, borderStyle: 'rounded', borderColor: '#374151',
  });
  composerPanel.add(composer);

  const rightPanel = new BoxRenderable(renderer, { id: 'right', flexDirection: 'column', flexGrow: 1, width: '100%', height: '100%' });
  rightPanel.add(messagePanel);
  rightPanel.add(composerPanel);

  const body = new BoxRenderable(renderer, { id: 'body', flexDirection: 'row', width: '100%', height: '100%' });
  body.add(conversationPanel);
  body.add(rightPanel);

  const root = new BoxRenderable(renderer, { id: 'root', flexDirection: 'column', width: '100%', height: '100%' });
  root.add(header);
  root.add(body);

  renderer.root.add(root);
  imSelect.focus();

  const handleSelect = async (channel: SlackChannel | undefined) => selectChannel(channel, renderer, client, messageBox, messageScroll, composer, statusBar, options.limit);

  imSelect.on('itemSelected', async (index: number) => handleSelect(state.imChannels[index]));
  privateSelect.on('itemSelected', async (index: number) => handleSelect(state.privateChannels[index]));

  const renderAndScroll = async () => {
    renderMessages(renderer, messageBox, messageScroll, state.selectedMessageIdx);
    if (state.selectedMessageIdx >= 0) {
      const selectedMsg = state.messages[state.selectedMessageIdx];
      if (selectedMsg) {
        const ident = `${state.selectedMessageIdx}-${selectedMsg.ts.replace('.', '-')}`;
        await scrollChildIntoView(renderer, messageScroll, `msg-row-${ident}`);
      }
    } else {
      await scrollToBottom(renderer, messageBox, messageScroll);
    }
  };

  const selectIdx = async (idx: number) => {
    state.selectedMessageIdx = Math.max(-1, Math.min(idx, state.messages.length - 1));
    await renderAndScroll();
  };

  composer.on('enter', async (value: string) => {
    if (!state.selectedId) {
      state.status = 'Select a conversation first.';
      renderStatus(statusBar);
      return;
    }
    await sendMessage(renderer, client, state.selectedId, value, composer, messageBox, messageScroll, statusBar);
  });

  renderer.keyInput.on('keypress', async (key) => {
    if (key.name === 'q') {
      renderer.destroy();
      return;
    }

    if (key.ctrl && key.name === 'c') {
      const editor = renderer.currentFocusedEditor;
      const selected = editor?.getSelectedText() || renderer.currentFocusedRenderable?.getSelectedText();
      if (selected) {
        const result = await writeClipboard(selected);
        state.status = result.success ? 'Copied!' : `Clipboard error: ${result.error}`;
        renderStatus(statusBar);
      }
      return;
    }

    if (key.ctrl && key.name === 'return') {
      if (state.threadView) return;
      if (state.selectedMessageIdx < 0) return;
      const msg = state.messages[state.selectedMessageIdx];
      if (!msg || !msg.reply_count) return;
      await openThread(renderer, client, msg, messageBox, messageScroll, statusBar);
      return;
    }

    if (key.name === 'escape') {
      if (state.threadView) {
        await closeThread(renderer, client, messageBox, messageScroll, statusBar);
        messageScroll.focus();
        return;
      }
      if (state.selectedMessageIdx >= 0) {
        state.selectedMessageIdx = -1;
        await renderAndScroll();
        composer.focus();
        return;
      }
      imSelect.focus();
      return;
    }

    if (key.name === 'up') {
      const cur = renderer.currentFocusedRenderable;
      if (cur === composer && !composer.value.trim()) {
        messageScroll.focus();
        await selectIdx(state.messages.length - 1);
        return;
      }
      if (cur === messageScroll) {
        const curIdx = state.selectedMessageIdx >= 0 ? state.selectedMessageIdx : state.messages.length;
        await selectIdx(curIdx - 1);
        return;
      }
    }

    if (key.name === 'down') {
      if (renderer.currentFocusedRenderable === messageScroll) {
        const curIdx = state.selectedMessageIdx >= 0 ? state.selectedMessageIdx : -1;
        await selectIdx(curIdx + 1);
        return;
      }
    }

    if (key.name === 'r') {
      if (state.selectedId) {
        await loadMessages(renderer, client, state.selectedId, messageBox, messageScroll, statusBar, options.limit);
      } else {
        await loadConversations(renderer, client, imSelect, privateSelect, statusBar, options.types, options.limit);
      }
    }

    if (key.name === 'tab') {
      const cur = renderer.currentFocusedRenderable;
      if (cur === imSelect) privateSelect.focus();
      else if (cur === privateSelect) messageScroll.focus();
      else if (cur === messageScroll) composer.focus();
      else imSelect.focus();
    }
  });

  await loadConversations(renderer, client, imSelect, privateSelect, statusBar, options.types, options.limit);

  if (options.channel) {
    const foundIm = state.imChannels.find(ch => ch.id === options.channel);
    const foundPriv = state.privateChannels.find(ch => ch.id === options.channel);
    const found = foundIm || foundPriv;
    if (found) {
      if (foundIm) {
        const idx = state.imChannels.indexOf(foundIm);
        imSelect.setSelectedIndex(idx);
        imSelect.selectCurrent();
      } else {
        const idx = state.privateChannels.indexOf(foundPriv!);
        privateSelect.setSelectedIndex(idx);
        privateSelect.selectCurrent();
      }
    } else {
      state.status = `Channel ${options.channel} not found.`;
      renderStatus(statusBar);
    }
  }
}
