import type {
  BarkChannelConfig,
  ChannelConfig,
  NormalizedConfig,
  SmtpChannelConfig,
  WebhookChannelConfig,
  NoticeLanguage,
} from "./types.js";
import {noticeText} from "./i18n.js";

export interface SecretWrite {
  ref: string;
  value: string;
}

interface HostReact {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
}

interface UiComponent {
  (props: Record<string, unknown>): unknown;
}

interface InputKey {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

interface UiKit {
  Box: UiComponent;
  Text: UiComponent;
  useInput(handler: (input: string, key: InputKey) => void): void;
  useTerminalSize(): {rows: number; columns: number};
}

interface PanelChannel {
  notify(text: string, options?: {color?: "error" | "warning" | "success"; timeoutMs?: number}): void;
}

interface PanelProps {
  React: HostReact;
  ui: UiKit;
  lang?: NoticeLanguage;
  channel: PanelChannel;
  close(): void;
}

export interface NoticePanelProps extends PanelProps {
  getSettings(): NormalizedConfig;
  saveSettings(next: NormalizedConfig, secretWrites: readonly SecretWrite[]): Promise<void>;
  testChannels(channelIds?: readonly string[], language?: NoticeLanguage): Promise<readonly {channelId: string; accepted: boolean; detail?: string}[]>;
  setNotificationLanguage?(language: NoticeLanguage): void;
}

type Mode = "list" | "type" | "form" | "text";
type DraftField =
  | "id"
  | "host"
  | "port"
  | "secure"
  | "requireTls"
  | "from"
  | "displayName"
  | "to"
  | "username"
  | "passwordRef"
  | "password"
  | "replyTo"
  | "url"
  | "apiUrl"
  | "secretRef"
  | "secret"
  | "deviceKey"
  | "timeoutMs"
  | "allowInsecureHttp"
  | "allowPrivateNetwork"
  | "headers"
  | "encryption"
  | "sendTest"
  | "threshold";

interface Draft {
  channel: ChannelConfig;
  secretValue: string;
}

interface FormField {
  key: DraftField;
  label: string;
  kind: "text" | "boolean" | "choice" | "action";
  hint?: string;
}

const h = (React: HostReact, type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown =>
  React.createElement(type, props, ...children);

export function NoticePanel(props: NoticePanelProps): unknown {
  const {React, ui} = props;
  const lang = props.lang ?? "zh";
  const {rows} = ui.useTerminalSize();
  const [settings, setSettings] = React.useState<NormalizedConfig>(() => props.getSettings());
  const [mode, setMode] = React.useState<Mode>("list");
  const [focus, setFocus] = React.useState(0);
  const [typeFocus, setTypeFocus] = React.useState(0);
  const [draft, setDraft] = React.useState<Draft | undefined>(undefined);
  const [editing, setEditing] = React.useState<{field: DraftField; text: string} | undefined>(undefined);
  const [notice, setNotice] = React.useState(noticeText(lang, "list-hint"));
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  React.useEffect(() => {
    setNotice(noticeText(lang, mode === "list" ? "list-hint" : mode === "type" ? "type-hint" : mode === "form" ? "form-hint" : "text-hint"));
    props.setNotificationLanguage?.(lang);
  }, [lang]);

  const channelRows = settings.channels;
  const listLength = channelRows.length + 3;
  const selectedChannel = focus >= 2 && focus < channelRows.length + 2 ? channelRows[focus - 2] : undefined;

  const openTypePicker = (): void => {
    setTypeFocus(0);
    setMode("type");
    setNotice(noticeText(lang, "type-hint"));
  };

  const openForm = (channel: ChannelConfig): void => {
    setDraft({channel: cloneChannel(channel), secretValue: ""});
    setFocus(0);
    setMode("form");
    setNotice(noticeText(lang, "form-hint"));
  };

  const saveDraft = async (): Promise<void> => {
    if (draft === undefined) return;
    const channel = withSecretRef(draft.channel, draft.secretValue);
    const nextChannels = channelRows.some((item) => item.id === channel.id)
      ? channelRows.map((item) => item.id === channel.id ? channel : item)
      : [...channelRows, channel];
    const next = {...settings, channels: nextChannels};
    setBusy(true);
    try {
      await props.saveSettings(next, secretWritesFor(channel, draft.secretValue));
      const resolved = props.getSettings();
      setSettings(resolved.channels.some((item) => item.id === channel.id) ? resolved : next);
      setDraft(undefined);
      setMode("list");
      setFocus(Math.max(2, nextChannels.findIndex((item) => item.id === channel.id) + 2));
      setNotice(noticeText(lang, "saved-channel", {id: channel.id}));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : noticeText(lang, "save-error"));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (): Promise<void> => {
    const next = {...settings, enabled: !settings.enabled};
    setBusy(true);
    try {
      await props.saveSettings(next, []);
      setSettings(next);
      setNotice(next.enabled ? noticeText(lang, "enabled-notice") : noticeText(lang, "disabled-notice"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : noticeText(lang, "settings-error"));
    } finally {
      setBusy(false);
    }
  };

  const toggleChannel = async (channel: ChannelConfig): Promise<void> => {
    const next = {...settings, channels: channelRows.map((item) => item.id === channel.id
      ? {...item, enabled: item.enabled === false}
      : item)};
    setBusy(true);
    try {
      await props.saveSettings(next, []);
      setSettings(next);
      setNotice(channel.enabled === false
        ? noticeText(lang, "channel-enabled", {id: channel.id})
        : noticeText(lang, "channel-disabled", {id: channel.id}));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : noticeText(lang, "channel-state-error"));
    } finally {
      setBusy(false);
    }
  };

  const deleteChannel = async (channel: ChannelConfig): Promise<void> => {
    const next = {...settings, channels: channelRows.filter((item) => item.id !== channel.id)};
    setBusy(true);
    try {
      await props.saveSettings(next, []);
      setSettings(next);
      setFocus(Math.min(focus, Math.max(0, next.channels.length + 1)));
      setNotice(noticeText(lang, "deleted-channel", {id: channel.id}));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : noticeText(lang, "delete-error"));
    } finally {
      setBusy(false);
    }
  };

  const test = (channel?: ChannelConfig): void => {
    if (channel?.enabled === false) {
      setNotice(noticeText(lang, "disabled-send"));
      return;
    }
    if (testing) {
      setNotice(noticeText(lang, "testing-wait"));
      return;
    }
    const savedChannel = channel === undefined ? undefined : channelRows.find((item) => item.id === channel.id);
    if ((channel?.type === "smtp" || channel?.type === "bark") && savedChannel === undefined) {
      setNotice(noticeText(lang, channel.type === "bark" ? "save-first-bark" : "save-first"));
      return;
    }
    props.setNotificationLanguage?.(lang);
    setTesting(true);
    setNotice(channel?.type === "smtp"
      ? noticeText(lang, "sending-mail")
      : channel?.type === "bark"
        ? noticeText(lang, "sending-bark")
        : noticeText(lang, "sending-webhook"));
    void props.testChannels(channel === undefined ? undefined : [channel.id], lang).then((results) => {
      const failed = results.filter((result) => !result.accepted);
      const label = channel?.type === "smtp"
        ? noticeText(lang, "test-mail-label")
        : channel?.type === "bark"
          ? noticeText(lang, "test-bark-label")
          : channel?.type === "webhook"
            ? noticeText(lang, "test-webhook-label")
            : noticeText(lang, "test-all-label");
      if (results.length === 0) {
        setNotice(noticeText(lang, "no-enabled"));
        return;
      }
      setNotice(failed.length === 0
        ? noticeText(lang, "sent-count", {label, count: results.length})
        : noticeText(lang, "failed-label", {label, detail: failed.map((result) => formatFailure(result, lang)).join(lang === "zh" ? "；" : "; ")}));
    }).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : noticeText(lang, "test-error"));
    }).finally(() => setTesting(false));
  };

  ui.useInput((input, key) => {
    if (busy) return;
    if (mode === "text" && editing !== undefined && draft !== undefined) {
      if (key.escape) {
        setEditing(undefined);
        setMode("form");
        return;
      }
      if (key.return) {
        setDraft({...draft, channel: updateDraftField(draft.channel, editing.field, editing.text), secretValue: editing.field === "password" || editing.field === "secret" || editing.field === "deviceKey" ? editing.text : draft.secretValue});
        setEditing(undefined);
        setMode("form");
        return;
      }
      if (key.backspace || key.delete) {
        setEditing({...editing, text: editing.text.slice(0, -1)});
        return;
      }
      if (input && !/\p{Cc}/u.test(input)) setEditing({...editing, text: `${editing.text}${input}`});
      return;
    }

    if (mode === "text" && editing?.field === "threshold") {
      if (key.escape) {
        setEditing(undefined);
        setMode("list");
        return;
      }
      if (key.return) {
        const value = Number(editing.text);
        if (!Number.isInteger(value) || value < 1 || value > 31536000) {
          setNotice(noticeText(lang, "threshold-error"));
          return;
        }
        const next = {...settings, thresholdSeconds: value};
        setBusy(true);
        void props.saveSettings(next, []).then(() => {
          setSettings(next);
          setEditing(undefined);
          setMode("list");
          setNotice(noticeText(lang, "threshold-saved", {value: formatSeconds(value, lang)}));
        }).catch((error: unknown) => {
          setNotice(error instanceof Error ? error.message : noticeText(lang, "settings-error"));
        }).finally(() => setBusy(false));
        return;
      }
      if (key.backspace || key.delete) {
        setEditing({...editing, text: editing.text.slice(0, -1)});
        return;
      }
      if (input && !/\p{Cc}/u.test(input)) setEditing({...editing, text: `${editing.text}${input}`});
      return;
    }

    if (key.escape || input === "q") {
      if (mode === "list") props.close();
      else {
        setMode(mode === "form" ? "list" : mode === "text" ? "form" : "list");
        setNotice(mode === "form" ? noticeText(lang, "cancelled-edit") : noticeText(lang, "list-hint"));
      }
      return;
    }

    if (mode === "type") {
      if (key.upArrow || key.downArrow) setTypeFocus((typeFocus + (key.downArrow ? 1 : 2)) % 3);
      else if (key.return) {
        const channel = typeFocus === 0 ? newSmtpChannel() : typeFocus === 1 ? newWebhookChannel() : newBarkChannel();
        setDraft({channel, secretValue: ""});
        setFocus(0);
        setMode("form");
        setNotice(noticeText(lang, "form-hint"));
      }
      return;
    }

    if (mode === "form" && draft !== undefined) {
      const fields = formFields(draft.channel, lang);
      if (key.upArrow) setFocus(Math.max(0, focus - 1));
      else if (key.downArrow) setFocus(Math.min(fields.length - 1, focus + 1));
      else if (input === "s") void saveDraft();
      else if (key.return) {
        const field = fields[focus];
        if (field === undefined) return;
        if (field.kind === "action") {
          if (field.key === "sendTest") void test(draft.channel);
        } else if (field.kind === "boolean") {
          setDraft({...draft, channel: toggleDraftBoolean(draft.channel, field.key)});
        } else if (field.kind === "choice") {
          setDraft({...draft, channel: cycleSmtpEncryption(draft.channel)});
        } else {
          setEditing({field: field.key, text: editableText(draft, field.key, lang)});
          setMode("text");
        }
      }
      return;
    }

    if (key.upArrow) setFocus(Math.max(0, focus - 1));
    else if (key.downArrow) setFocus(Math.min(listLength - 1, focus + 1));
    else if (input === "n") openTypePicker();
    else if (input === "e" && selectedChannel !== undefined) openForm(selectedChannel);
    else if (input === "d" && selectedChannel !== undefined) void deleteChannel(selectedChannel);
    else if (input === "t") void test(selectedChannel);
    else if (key.return) {
      if (focus === 0) void toggleEnabled();
      else if (focus === 1) {
        setEditing({field: "threshold", text: String(settings.thresholdSeconds)});
        setMode("text");
      } else if (selectedChannel !== undefined) {
        void toggleChannel(selectedChannel);
      } else {
        openTypePicker();
      }
    }
  });

  const panelHeight = Math.max(8, Math.floor(rows / 2));
  const content = mode === "list"
    ? renderList(React, ui, lang, settings, focus, notice, busy, testing)
    : mode === "type"
      ? renderTypePicker(React, ui, lang, typeFocus, notice)
      : mode === "text"
        ? renderTextEditor(React, ui, lang, draft, editing, notice)
        : renderForm(React, ui, lang, draft, focus, notice, busy, panelHeight);

  return h(React, ui.Box, {
    flexDirection: "column",
    width: "100%",
    height: panelHeight,
    overflow: "hidden",
    borderStyle: "round",
    borderColor: "permission",
    paddingX: 1,
    opaque: true,
  }, content);
}

function renderList(
  React: HostReact,
  ui: UiKit,
  lang: NoticeLanguage,
  settings: NormalizedConfig,
  focus: number,
  notice: string,
  busy: boolean,
  testing: boolean,
): unknown {
  const children: unknown[] = [
    h(React, ui.Text, {bold: true, color: "permission"}, noticeText(lang, "title")),
    h(React, ui.Text, {dimColor: true}, noticeText(lang, "threshold-description", {value: formatSeconds(settings.thresholdSeconds, lang)})),
    h(React, ui.Text, {color: focus === 0 ? "remember" : undefined}, `${focus === 0 ? "› " : "  "}${lang === "zh" ? "总开关" : "Enabled"}: ${settings.enabled ? noticeText(lang, "enabled-on") : noticeText(lang, "enabled-off")}`),
    h(React, ui.Text, {color: focus === 1 ? "remember" : undefined}, `${focus === 1 ? "› " : "  "}${noticeText(lang, "threshold")}: ${formatSeconds(settings.thresholdSeconds, lang)} (${settings.thresholdSeconds}s)`),
    h(React, ui.Text, {bold: true, dimColor: true}, noticeText(lang, "channels")),
  ];
  settings.channels.forEach((channel, index) => {
    const selected = focus === index + 2;
    const typeLabel = channel.type === "smtp" ? "SMTP" : channel.type === "webhook" ? noticeText(lang, "webhook") : noticeText(lang, "bark");
    children.push(h(React, ui.Text, {color: selected ? "remember" : undefined}, `${selected ? "› " : "  "}${channel.enabled === false ? "○" : "●"} ${channel.id} · ${typeLabel}`));
  });
  const addFocus = focus === settings.channels.length + 2;
  children.push(h(React, ui.Text, {color: addFocus ? "remember" : "success"}, `${addFocus ? "› " : "  +"} ${noticeText(lang, "add-channel")}`));
  children.push(h(React, ui.Text, {dimColor: true, italic: true}, busy ? (lang === "zh" ? "处理中…" : "Processing…") : testing ? noticeText(lang, "testing") : notice));
  return h(React, ui.Box, {flexDirection: "column", gap: 0}, ...children);
}

function renderTypePicker(React: HostReact, ui: UiKit, lang: NoticeLanguage, focus: number, notice: string): unknown {
  return h(React, ui.Box, {flexDirection: "column", gap: 1},
    h(React, ui.Text, {bold: true, color: "permission"}, noticeText(lang, "new-channel")),
    h(React, ui.Text, {color: focus === 0 ? "remember" : undefined}, `${focus === 0 ? "› " : "  "}${noticeText(lang, "smtp")}`),
    h(React, ui.Text, {color: focus === 1 ? "remember" : undefined}, `${focus === 1 ? "› " : "  "}${noticeText(lang, "webhook")}`),
    h(React, ui.Text, {color: focus === 2 ? "remember" : undefined}, `${focus === 2 ? "› " : "  "}${noticeText(lang, "bark")}`),
    h(React, ui.Text, {dimColor: true, italic: true}, notice),
  );
}

function renderForm(
  React: HostReact,
  ui: UiKit,
  lang: NoticeLanguage,
  draft: Draft | undefined,
  focus: number,
  notice: string,
  busy: boolean,
  panelHeight: number,
): unknown {
  if (draft === undefined) return h(React, ui.Text, null, noticeText(lang, "no-draft"));
  const fields = formFields(draft.channel, lang);
  const visibleCount = Math.max(3, panelHeight - 4);
  const maxStart = Math.max(0, fields.length - visibleCount);
  const start = Math.min(
    Math.max(0, focus - Math.floor(visibleCount / 2)),
    maxStart,
  );
  const children: unknown[] = [h(React, ui.Text, {bold: true, color: "permission"}, draft.channel.type === "smtp"
    ? noticeText(lang, "edit-smtp")
    : draft.channel.type === "webhook"
      ? noticeText(lang, "edit-webhook")
      : noticeText(lang, "edit-bark"))];
  fields.slice(start, start + visibleCount).forEach((field, offset) => {
    const index = start + offset;
    const selected = index === focus;
    const value = draftText(draft, field.key, lang);
    const renderedValue = field.kind === "action"
      ? noticeText(lang, "send-enter")
      : field.kind === "boolean"
        ? (value === "true" ? noticeText(lang, "enabled-on") : noticeText(lang, "enabled-off"))
        : value || `(${noticeText(lang, "not-set")})`;
    children.push(h(React, ui.Text, {color: selected ? "remember" : undefined}, `${selected ? "› " : "  "}${field.label}${field.kind === "action" ? "" : ": "}${renderedValue}`));
  });
  const scrollHint = fields.length > visibleCount ? noticeText(lang, "field-count", {current: focus + 1, total: fields.length}) : "";
  children.push(h(React, ui.Text, {dimColor: true, italic: true}, `${busy ? noticeText(lang, "saving") : notice}${scrollHint}`));
  return h(React, ui.Box, {flexDirection: "column", gap: 0}, ...children);
}

function renderTextEditor(React: HostReact, ui: UiKit, lang: NoticeLanguage, draft: Draft | undefined, editing: {field: DraftField; text: string} | undefined, notice: string): unknown {
  if (editing === undefined || (draft === undefined && editing.field !== "threshold")) return h(React, ui.Text, null, noticeText(lang, "no-field"));
  const secret = editing.field === "password" || editing.field === "secret" || editing.field === "deviceKey";
  const display = secret ? "•".repeat(editing.text.length) : editing.text;
  return h(React, ui.Box, {flexDirection: "column", gap: 1},
    h(React, ui.Text, {bold: true, color: "permission"}, fieldLabel(editing.field, lang)),
    h(React, ui.Text, null, `❯ ${display}▌`),
    h(React, ui.Text, {dimColor: true, italic: true}, `${notice} · ${noticeText(lang, "text-hint")}`),
  );
}

function formFields(channel: ChannelConfig, lang: NoticeLanguage): FormField[] {
  const text = (key: Parameters<typeof noticeText>[1]): string => noticeText(lang, key);
  if (channel.type === "smtp") return [
    {key: "id", label: text("field-id"), kind: "text"},
    {key: "username", label: text("field-username"), kind: "text"},
    {key: "from", label: text("field-from"), kind: "text"},
    {key: "password", label: text("field-password"), kind: "text"},
    {key: "displayName", label: text("field-display-name"), kind: "text"},
    {key: "host", label: text("field-host"), kind: "text"},
    {key: "port", label: text("field-port"), kind: "text"},
    {key: "encryption", label: text("field-encryption"), kind: "choice"},
    {key: "to", label: text("field-to"), kind: "text"},
    {key: "sendTest", label: text("field-send-test"), kind: "action"},
    {key: "replyTo", label: text("field-reply-to"), kind: "text"},
  ];
  if (channel.type === "bark") return [
    {key: "id", label: text("field-id"), kind: "text"},
    {key: "apiUrl", label: text("field-api-url"), kind: "text"},
    {key: "deviceKey", label: text("field-device-key"), kind: "text"},
    {key: "timeoutMs", label: text("field-timeout"), kind: "text"},
    {key: "allowInsecureHttp", label: text("field-allow-http"), kind: "boolean"},
    {key: "allowPrivateNetwork", label: text("field-allow-private"), kind: "boolean"},
  ];
  return [
    {key: "id", label: text("field-id"), kind: "text"},
    {key: "url", label: text("field-url"), kind: "text"},
    {key: "secretRef", label: text("field-secret-ref"), kind: "text"},
    {key: "secret", label: text("field-secret"), kind: "text"},
    {key: "timeoutMs", label: text("field-timeout"), kind: "text"},
    {key: "allowInsecureHttp", label: text("field-allow-http"), kind: "boolean"},
    {key: "allowPrivateNetwork", label: text("field-allow-private"), kind: "boolean"},
    {key: "headers", label: text("field-headers"), kind: "text"},
  ];
}

function fieldLabel(field: DraftField, lang: NoticeLanguage): string {
  if (field === "threshold") return noticeText(lang, "threshold-label");
  return formFields(newSmtpChannel(), lang).concat(formFields(newWebhookChannel(), lang), formFields(newBarkChannel(), lang)).find((item) => item.key === field)?.label ?? field;
}

function draftText(draft: Draft, field: DraftField, lang: NoticeLanguage): string {
  if (field === "password" || field === "secret" || field === "deviceKey") {
    const configuredRef = draft.channel.type === "smtp"
      ? draft.channel.passwordRef
      : draft.channel.type === "webhook"
        ? draft.channel.secretRef
        : draft.channel.deviceKeyRef;
    return draft.secretValue || configuredRef
      ? "******"
      : "";
  }
  if (field === "encryption" && draft.channel.type === "smtp") return smtpEncryption(draft.channel, lang);
  if (field === "sendTest") return "";
  const value = (draft.channel as unknown as Record<string, unknown>)[field];
  if (field === "to" && Array.isArray(value)) return value.join(", ");
  if (field === "headers" && value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}=${String(item)}`).join("; ");
  return value === undefined ? "" : String(value);
}

function editableText(draft: Draft, field: DraftField, lang: NoticeLanguage): string {
  if (field === "password" || field === "secret" || field === "deviceKey") return "";
  return draftText(draft, field, lang);
}

function updateDraftField(channel: ChannelConfig, field: DraftField, text: string): ChannelConfig {
  const next = {...channel} as ChannelConfig & Record<string, unknown>;
  if (field === "password" || field === "secret" || field === "deviceKey") return channel;
  if (field === "port" || field === "timeoutMs") next[field] = Number(text);
  else if (field === "to") next.to = text.split(",").map((item) => item.trim()).filter(Boolean);
  else if (field === "headers") next.headers = parseHeaders(text);
  else next[field] = text;
  return next;
}

function toggleDraftBoolean(channel: ChannelConfig, field: DraftField): ChannelConfig {
  const next = {...channel} as ChannelConfig;
  (next as unknown as Record<string, unknown>)[field] = (next as unknown as Record<string, unknown>)[field] !== true;
  return next;
}

function smtpEncryption(channel: SmtpChannelConfig, lang: NoticeLanguage): string {
  if (channel.secure) return noticeText(lang, "encryption-ssl");
  if (channel.requireTls !== false) return noticeText(lang, "encryption-tls");
  return noticeText(lang, "encryption-none");
}

function cycleSmtpEncryption(channel: ChannelConfig): ChannelConfig {
  if (channel.type !== "smtp") return channel;
  const current = channel.secure ? "ssl" : channel.requireTls !== false ? "tls" : "none";
  const next = current === "ssl" ? "tls" : current === "tls" ? "none" : "ssl";
  return {...channel, secure: next === "ssl", requireTls: next === "tls"};
}

function withSecretRef(channel: ChannelConfig, secretValue: string): ChannelConfig {
  if (!secretValue) return channel;
  const base = channel.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const ref = channel.type === "smtp"
    ? `DSH_NOTICE_${base}_PASSWORD`
    : channel.type === "webhook"
      ? `DSH_NOTICE_${base}_SECRET`
      : `DSH_NOTICE_${base}_DEVICE_KEY`;
  if (channel.type === "smtp") return {...channel, passwordRef: channel.passwordRef || ref};
  if (channel.type === "webhook") return {...channel, secretRef: channel.secretRef || ref};
  return {...channel, deviceKeyRef: channel.deviceKeyRef || ref};
}

function secretWritesFor(channel: ChannelConfig, secretValue: string): SecretWrite[] {
  if (!secretValue) return [];
  const base = channel.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return [{
    ref: channel.type === "smtp"
      ? channel.passwordRef || `DSH_NOTICE_${base}_PASSWORD`
      : channel.type === "webhook"
        ? channel.secretRef || `DSH_NOTICE_${base}_SECRET`
        : channel.deviceKeyRef || `DSH_NOTICE_${base}_DEVICE_KEY`,
    value: secretValue,
  }];
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of text.split(";").map((item) => item.trim()).filter(Boolean)) {
    const index = entry.indexOf("=");
    if (index > 0) headers[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return headers;
}

function formatFailure(result: {channelId: string; detail?: string}, lang: NoticeLanguage): string {
  const detail = result.detail ? cleanNotice(result.detail) : lang === "zh" ? "未知错误" : "Unknown error";
  return `${result.channelId}: ${detail}`;
}

function cleanNotice(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\r\n]+/g, " ").slice(0, 240);
}

function cloneChannel(channel: ChannelConfig): ChannelConfig {
  if (channel.type === "smtp") return {...channel, to: [...channel.to]};
  if (channel.type === "webhook") return {...channel, headers: {...(channel.headers ?? {})}};
  return {...channel};
}

function newSmtpChannel(): SmtpChannelConfig {
  return {type: "smtp", id: "email", enabled: true, host: "", port: 587, secure: false, requireTls: true, from: "", displayName: "", to: [], username: "", passwordRef: "", replyTo: ""};
}

function newWebhookChannel(): WebhookChannelConfig {
  return {type: "webhook", id: "webhook", enabled: true, url: "", headers: {}, secretRef: "", timeoutMs: 10000, allowInsecureHttp: false, allowPrivateNetwork: false};
}

function newBarkChannel(): BarkChannelConfig {
  return {type: "bark", id: "bark", enabled: true, apiUrl: "https://api.day.app", deviceKeyRef: "", timeoutMs: 10000, allowInsecureHttp: false, allowPrivateNetwork: false};
}

function formatSeconds(seconds: number, lang: NoticeLanguage): string {
  if (seconds >= 3600) return lang === "zh"
    ? `${Math.floor(seconds / 3600)}小时 ${Math.floor(seconds % 3600 / 60)}分`
    : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  if (seconds >= 60) return lang === "zh"
    ? `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return lang === "zh" ? `${seconds}秒` : `${seconds}s`;
}
