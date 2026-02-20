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
