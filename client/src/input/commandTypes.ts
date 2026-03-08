import { describeCharacter } from './textInput';

export type ModeInput = {
  code: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
};

export type CommandDescriptor<CommandId extends string = string> = {
  id: CommandId;
  label: string;
  shortcut: string;
  tooltip: string;
  section: string;
};

function formatShortcutToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 1) {
    return describeCharacter(trimmed);
  }
  return trimmed;
}

export function formatCommandShortcut(shortcut: string): string {
  return shortcut
    .split('+')
    .map((token) => formatShortcutToken(token))
    .join('+');
}

/** Formats a palette/menu label as `Name: Key`. */
export function formatCommandMenuLabel(command: Pick<CommandDescriptor, 'label' | 'shortcut'>): string {
  return `${command.label}: ${formatCommandShortcut(command.shortcut)}`;
}
