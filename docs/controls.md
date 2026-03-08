# Controls Reference

This document is the authoritative keymap for the client.

## Normal Mode

### Movement
- `Arrow Keys`: Move
- `Shift+K`, `Applications`, or `Shift+F10`: Open the command palette in supported modes
- `?`: Open help viewer
- `C`: Speak coordinates
- `Escape`: Press once for disconnect prompt, press again to disconnect

### Users, Nickname, Chat
- `L`: Locate nearest user
- `Shift+L`: List users alphabetically; `Enter` teleports to selected user; `ArrowLeft`/`ArrowRight` adjust selected user volume
- `U`: Speak connected users
- `N`: Edit nickname
- `/`: Start chat
- In chat, commands are supported when `/` is the first character:
  - `/me <action>`: Send action text without `name:`
  - `/up`: Show server uptime (self only)
  - `/version`: Show server version (self only)
- `Shift+Z`: Admin menu (when role permissions allow)
- `,` / `.`: Previous/next message
- `<` / `>`: First/last message

### Items
- `I`: Locate nearest item
- `Shift+I`: List items and teleport to selected item with `Enter`
- `A`: Add item
- `O`: Edit item properties
- `Shift+O`: Inspect all item properties
- `D`: Pick up/drop item
- `Z`: Item management menu (delete/transfer when permitted)
- `Space` in item management menu: Read tooltip/help for the selected action
- `Enter`: Use item
- `Shift+Enter`: Secondary item action

### Audio
- `P`: Ping server
- `V`: Set microphone gain
- `Shift+V`: Microphone calibration
- `M`: Mute/unmute local microphone
- `Shift+M`: Toggle stereo/mono output
- `Shift+1` (`!`): Toggle loopback monitor
- `1`: Toggle voice layer
- `2`: Toggle item layer (emit sounds)
- `3`: Toggle media layer (radio)
- `4`: Toggle world layer (other-user world sounds)
- `E`: Effect select menu
- `-` / `=`: Lower/raise master volume
- `_` / `+` (`Shift+-` / `Shift+=`): Lower/raise active effect value

## Text Entry Modes (`nickname`, `chat`, `itemPropertyEdit`)

- `Enter`: Confirm
- `Escape`: Cancel
- `ArrowLeft` / `ArrowRight`: Move cursor by character
- `Ctrl+ArrowLeft` / `Ctrl+ArrowRight`: Move cursor by word (notepad-style)
- `Home` / `End`: Move to start/end
- `Backspace`: Delete previous character
- `Delete`: Delete current character
- `Ctrl+A`: Select all (replace-on-next-type)
- `Ctrl+C`: Copy current text
- `Ctrl+X`: Cut current text
- `Ctrl+V`: Paste
- `Cmd+A` / `Cmd+C` / `Cmd+X` / `Cmd+V` (macOS): same behavior as `Ctrl` shortcuts above

## Numeric Edit Fields

- `ArrowUp` / `ArrowDown`: Step value
- `PageUp` / `PageDown`: Step by 10 increments

## Menu/List Navigation Modes

Applies to effect select, user/item list modes, item selection, item property list, and property option select.

- `ArrowUp` / `ArrowDown`: Move selection
- `PageUp` / `PageDown` in item property list: Jump 10 values for left/right-editable option fields
- `PageUp` / `PageDown` in item property option select: Jump 10 options backward/forward
- `ArrowLeft` / `ArrowRight` in user list: Lower/raise selected user listen volume (`0.5..4.0`)
- `Enter`: Confirm selection
- `Escape`: Exit/cancel
- `Space`: Read tooltip/help for current option (where metadata is available)
- First-letter navigation: jump to next matching entry

## Command Palette

- Available in `normal` mode and `pianoUse` mode
- Opens with `Shift+K`, `Applications`, or `Shift+F10`
- Shows only commands available in the current mode/context
- `ArrowUp` / `ArrowDown`: Move selection
- `Enter`: Run selected command
- `Escape`: Close palette and return to prior mode
- `Space`: Read tooltip/help for selected command
- First-letter navigation: jump to next matching command

## Yes/No Confirmation Menu

- `ArrowUp` / `ArrowDown`: Move between `No` and `Yes`
- `Enter`: Confirm current choice (default selection is `No`)
- `Escape`: Cancel

## Admin Modes

- `Shift+Z`: Open admin menu
- `Space` on admin root actions: Read tooltip/help for the selected action
- Admin menu options are permission-gated and include:
  - role management
  - change user role
  - ban user
  - unban user
  - delete account
- In admin role management:
  - role list includes role user-counts
  - `Enter` on role opens permission toggles
  - `Enter` on `Add role` opens role name editor
  - role delete prompts replacement role selection

## Piano Use Mode

- `1-9` (and `0` for the 10th slot): Switch instrument preset quickly
- `A S D F G H J K L ; '`: Play white keys (C major from C4 upward)
- `W E T Y U O P ]`: Play sharps
- Multiple keys can be held/played at once
- Shifted note keys are ignored
- `?`: Open piano-mode help viewer
- `-` / `=`: Shift octave down/up
- `Z`: Start, pause, or resume recording on this piano (max 30s recorded time)
- `X`: Play back saved recording on this piano (stops demo first)
- `Enter`: Play demo melody (press again to restart; stops recording playback first)
- `C`: Stop demo, recording playback, and active recording
- `Escape`: Exit piano mode

## Help Viewer Mode

- `ArrowUp` / `ArrowDown`: Previous/next help line
- `Home` / `End`: First/last help line
- `Escape`: Exit help viewer
- No first-letter navigation in this mode
