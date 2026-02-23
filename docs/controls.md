# Controls Reference

This document is the authoritative keymap for the client.

## Normal Mode

### Movement
- `Arrow Keys`: Move
- `?`: Open help viewer
- `C`: Speak coordinates
- `Escape`: Press once for disconnect prompt, press again to disconnect

### Users, Nickname, Chat
- `L`: Locate nearest user
- `Shift+L`: List users and teleport to selected user with `Enter`
- `U`: Speak connected users
- `Shift+U`: List users alphabetically
- `N`: Edit nickname
- `/`: Start chat
- `,` / `.`: Previous/next message
- `<` / `>`: First/last message

### Items
- `I`: Locate nearest item
- `Shift+I`: List items and teleport to selected item with `Enter`
- `A`: Add item
- `O`: Edit item properties
- `Shift+O`: Inspect all item properties
- `D`: Pick up/drop item
- `Shift+D`: Delete item
- `Enter`: Use item

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

## Numeric Edit Fields

- `ArrowUp` / `ArrowDown`: Step value
- `PageUp` / `PageDown`: Step by 10 increments

## Menu/List Navigation Modes

Applies to effect select, user/item list modes, item selection, item property list, and property option select.

- `ArrowUp` / `ArrowDown`: Move selection
- `ArrowLeft` / `ArrowRight` in user list: Lower/raise selected user listen volume (`0.5..4.0`)
- `Enter`: Confirm selection
- `Escape`: Exit/cancel
- `Space`: Read tooltip/help for current option (where metadata is available)
- First-letter navigation: jump to next matching entry

## Help Viewer Mode

- `ArrowUp` / `ArrowDown`: Previous/next help line
- `Home` / `End`: First/last help line
- `Escape`: Exit help viewer
- No first-letter navigation in this mode
