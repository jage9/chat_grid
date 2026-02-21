export function applyTextInput(
  key: string,
  currentString: string,
  cursorPos: number,
  maxLength: number,
): { newString: string; newCursorPos: number } {
  let newString = currentString;
  let newCursorPos = cursorPos;
  const lowerKey = key.toLowerCase();

  if (lowerKey === 'arrowleft') {
    newCursorPos = Math.max(0, cursorPos - 1);
  } else if (lowerKey === 'arrowright') {
    newCursorPos = Math.min(newString.length, cursorPos + 1);
  } else if (lowerKey === 'backspace') {
    if (cursorPos > 0) {
      newString = newString.slice(0, cursorPos - 1) + newString.slice(cursorPos);
      newCursorPos = cursorPos - 1;
    }
  } else if (lowerKey === 'home') {
    newCursorPos = 0;
  } else if (lowerKey === 'end') {
    newCursorPos = newString.length;
  } else if (key.length === 1 && newString.length < maxLength) {
    newString = newString.slice(0, cursorPos) + key + newString.slice(cursorPos);
    newCursorPos = cursorPos + 1;
  }

  return { newString, newCursorPos };
}

export function shouldReplaceCurrentText(
  code: string,
  key: string,
  replaceTextOnNextType: boolean,
): { replaceTextOnNextType: boolean; shouldReplace: boolean } {
  if (!replaceTextOnNextType) return { replaceTextOnNextType: false, shouldReplace: false };
  if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
    return { replaceTextOnNextType: false, shouldReplace: false };
  }
  if (code === 'Backspace' || code === 'Delete') {
    return { replaceTextOnNextType: false, shouldReplace: false };
  }
  if (key.length === 1) {
    return { replaceTextOnNextType: false, shouldReplace: true };
  }
  return { replaceTextOnNextType: true, shouldReplace: false };
}

export function normalizePastedText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, ' ')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

export function applyPastedText(
  raw: string,
  currentString: string,
  cursorPos: number,
  maxLength: number,
  replaceTextOnNextType: boolean,
): { handled: boolean; newString: string; newCursorPos: number; replaceTextOnNextType: boolean } {
  const text = normalizePastedText(raw);
  if (!text) {
    return { handled: true, newString: currentString, newCursorPos: cursorPos, replaceTextOnNextType };
  }
  if (replaceTextOnNextType) {
    const replacement = text.slice(0, maxLength);
    return {
      handled: true,
      newString: replacement,
      newCursorPos: replacement.length,
      replaceTextOnNextType: false,
    };
  }
  const available = Math.max(0, maxLength - currentString.length);
  if (available <= 0) {
    return { handled: true, newString: currentString, newCursorPos: cursorPos, replaceTextOnNextType: false };
  }
  const insert = text.slice(0, available);
  return {
    handled: true,
    newString: currentString.slice(0, cursorPos) + insert + currentString.slice(cursorPos),
    newCursorPos: cursorPos + insert.length,
    replaceTextOnNextType: false,
  };
}

export function mapTextInputKey(code: string, key: string): string {
  if (code === 'ArrowLeft') return 'arrowleft';
  if (code === 'ArrowRight') return 'arrowright';
  if (code === 'Backspace') return 'backspace';
  if (code === 'Home') return 'home';
  if (code === 'End') return 'end';
  return key;
}

function isWordCharacter(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

export function moveCursorWordLeft(text: string, cursorPos: number): number {
  if (cursorPos <= 0) return 0;
  let pos = cursorPos - 1;
  while (pos > 0 && !isWordCharacter(text[pos])) pos -= 1;
  while (pos > 0 && isWordCharacter(text[pos - 1])) pos -= 1;
  return pos;
}

export function moveCursorWordRight(text: string, cursorPos: number): number {
  let pos = cursorPos;
  while (pos < text.length && isWordCharacter(text[pos])) pos += 1;
  while (pos < text.length && !isWordCharacter(text[pos])) pos += 1;
  return pos;
}

function wordAtCursor(text: string, cursorPos: number): string | null {
  if (cursorPos < 0 || cursorPos >= text.length || !isWordCharacter(text[cursorPos])) {
    return null;
  }
  let start = cursorPos;
  while (start > 0 && isWordCharacter(text[start - 1])) start -= 1;
  let end = cursorPos + 1;
  while (end < text.length && isWordCharacter(text[end])) end += 1;
  return text.slice(start, end);
}

export function describeCharacter(ch: string): string {
  if (ch === ' ') return 'space';
  if (ch === '\t') return 'tab';
  if (ch === '.') return 'period';
  if (ch === ',') return 'comma';
  if (ch === ':') return 'colon';
  if (ch === ';') return 'semicolon';
  if (ch === '!') return 'exclamation mark';
  if (ch === '?') return 'question mark';
  if (ch === "'") return 'apostrophe';
  if (ch === '"') return 'quote';
  if (ch === '/') return 'slash';
  if (ch === '\\') return 'backslash';
  if (ch === '-') return 'dash';
  if (ch === '_') return 'underscore';
  if (ch === '=') return 'equals';
  if (ch === '+') return 'plus';
  if (ch === '*') return 'asterisk';
  if (ch === '&') return 'ampersand';
  if (ch === '@') return 'at sign';
  if (ch === '#') return 'hash';
  if (ch === '%') return 'percent';
  if (ch === '$') return 'dollar sign';
  if (ch === '^') return 'caret';
  if (ch === '|') return 'pipe';
  if (ch === '~') return 'tilde';
  if (ch === '`') return 'backtick';
  if (ch === '(') return 'left parenthesis';
  if (ch === ')') return 'right parenthesis';
  if (ch === '[') return 'left bracket';
  if (ch === ']') return 'right bracket';
  if (ch === '{') return 'left brace';
  if (ch === '}') return 'right brace';
  if (ch === '<') return 'less than';
  if (ch === '>') return 'greater than';
  return ch;
}

export function describeCursorCharacter(text: string, cursorPos: number): string | null {
  if (cursorPos < 0 || cursorPos > text.length) return null;
  if (cursorPos === text.length) return 'space';
  return describeCharacter(text[cursorPos]);
}

export function describeCursorWordOrCharacter(text: string, cursorPos: number): string | null {
  if (cursorPos === text.length) return 'space';
  const word = wordAtCursor(text, cursorPos);
  if (word) return word;
  return describeCursorCharacter(text, cursorPos);
}

export function describeBackspaceDeletedCharacter(text: string, cursorPos: number): string | null {
  if (cursorPos <= 0 || cursorPos > text.length) return null;
  return describeCharacter(text[cursorPos - 1]);
}
