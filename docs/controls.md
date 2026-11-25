# Controls Reference

This document is the authoritative keymap for the client.

## Property editors

In property editors, moving to a setting reads its name and current value. Adjusting the selected setting reads only the new value. For example, stepping a door's unlock timeout from 10 to 11 seconds reads “11 seconds.” Validation errors still explain what needs to change.

Press Space on a property row or in its option list to hear help for the current selection. Numeric property help includes the range and step when defined. In a numeric editor, Up and Down move one step, and Page Up and Page Down move ten. Text fields and private PIN entry keep their typing controls.

For saved platforms and items, you can press adjustment keys again or move to another property while an edit is pending. Each step builds on the server's accepted value. A successful adjustment is spoken only while its property is selected.

## Touch Controls

- Touch controls appear automatically on coarse-pointer devices and can be shown or hidden from Settings.
- Tap a direction for one movement step; press and hold to continue moving.
- The directional buttons remain Up, Down, Left, and Right; menu screens may use those same directions for navigation.
- `Use` performs the current primary action; in menus it becomes `Select`.
- `Back` cancels or exits the current menu.
- `Chat` opens a native mobile text field and `Commands` opens a visual popup list of available commands.
- `Mute` and `Unmute` show and change the current microphone state.
- The control dock can be collapsed without covering the grid.

## Normal Mode

### Movement
- `Arrow Keys`: In standard mode, move using compass directions. In HRTF mode, `ArrowUp` moves forward, `ArrowDown` moves backward, and `ArrowLeft`/`ArrowRight` strafe relative to your facing; moves advance at most one square per axis. Arrows do not change facing.
- `Q` / `E`: Turn facing left/right by 45 degrees in standard or HRTF mode; confirmed turns announce the new compass direction
- `Shift+K`, `Applications`, or `Shift+F10`: Open the command palette in supported modes
- `?`: Open help viewer
- `C`: Speak coordinates and any walls bordering the current square
- `F`: Announce your facing direction, one of eight compass directions
- `Escape`: Press once for disconnect prompt, press again to disconnect

### Users, Nickname, Chat
- `L`: Locate nearest user
- `Shift+L`: List users alphabetically with current presence; `Enter` teleports to selected user; `ArrowLeft`/`ArrowRight` adjust selected user volume
- In the user list, press `Applications` or `Shift+F10` to open actions for the selected person. You can also right-click their displayed row or use **Actions** on the touch dock. **Mute voice for me** silences only their incoming voice. Choose **Unmute voice for me** to hear them again at their selected volume. Muted rows announce “voice muted for you.” Signed-in listeners' choices are remembered for this grid and account on this device.
- `U`: Speak connected users
- `N`: Edit nickname
- `/`: Start chat
- In chat, commands are supported when `/` is the first character:
  - `/me <action>`: Send action text without `name:`
  - `/up`: Show server uptime (self only)
  - `/version`: Show server version (self only)
- `Shift+Z`: Users menu (available to the built-in user role and above)
- `,` / `.`: Previous/next message
- `<` / `>`: First/last message

### Items
- `H`: What are you holding?
- `I`: Locate nearest item
- `Shift+I`: List items and teleport to selected item with `Enter`
- `A`: Add item
- `O`: Edit item properties
- `Shift+O`: Inspect all item properties
- `D`: Pick up or drop item
- `Z`: Manage items
- `Duplicate here` in item management creates a separate copy on your square, owned by you, and returns you to the grid after a single confirmation. Anyone with item creation permission can duplicate another user's item. The usual creation quota and rate limit apply.
- `Hand to user`: Select an eligible nearby user to receive a held item without changing ownership.
- `Transfer ownership`: Change an item’s owner without moving it or changing who holds it.
- `Space` in item management menu: Read tooltip/help for the selected action
- `Enter`: Use item
- `Shift+Enter`: Secondary item action
- For an elevator, `Enter` calls or starts opening it, enters or exits only after the door is fully open, and has no boarding effect while the door is opening or closing.
- A two-stop car selects the other stop when you board. With three or more stops, boarding opens the shared floor selector. `Up`/`Down` browse destinations and direction, `Enter` requests the selected stop, and `Escape` closes the selector while you remain aboard. An open selector updates at departure and arrival, keeping the highlighted stop when it is still available. During a trip, each listed stop is described as above or below the current destination. **Choose floor** in Commands or touch controls reopens it. `Shift+Enter` reports the car's status.
- Elevator **Stops** accepts a comma-delimited list such as `0,20,40`. **Speed** controls Z units traveled per second, defaulting to 10. Exiting at a stop without a platform lands you on the highest platform below the shaft. If there is no platform below, you remain aboard.

### Wall doors

The keypad beeps once per digit. The success or failure sound plays after the fourth beep and a 0.3-second pause.

- Press Enter (touch Use) beside a door to open or close it. When a door shares a square with a usable item, choose the target. C includes each adjacent door's direction and state.
- From a keypad-protected side, Enter at a locked door requests unlock. If a PIN is required, type four digits directly. The fourth digit submits automatically. Escape cancels entry. After a successful unlock the door is still closed and anyone can open it with Enter. The free side of a one-sided door can open without a PIN.
- Shift+Enter (or the secondary action under Commands) requests manual Lock or Unlock. Closing an unlocked door leaves it unlocked. Only one person can enter digits on a door at once. Cancel or ten seconds without input releases the keypad.

### World Builder

Open **World Builder** with W or through Commands. **World checkpoints** offers these actions according to your permissions:

- **Save checkpoint** takes an optional label. Press Enter or touch Save checkpoint. The server confirms after writing the checkpoint.
- **Browse checkpoints** lists the newest first, 25 per page. Enter or Select previews a checkpoint with the changes it would make to the current world. Space reads help. Back returns to the selected row.
- **Restore this checkpoint** replaces the shared authored world for everyone. The confirmation starts on No. If the world changed after preview, review the new comparison and confirm again. A successful restore leaves a recovery checkpoint labeled **Before restore**.


- `W`: Open World Builder when the account has `world.structure.edit`.
- `Add wall`: Select a server-configured type, then select the north, south, east, or west edge of the current square. Successful creation opens the new wall directly in the shared wall editor.
- `Edit walls`: List current-floor walls nearest first, then change type, orientation, occupied edge anchors, slide, detailed properties, or delete the complete wall.
- `Set start edge` / `Set end edge`: Each entry shows its current `x, y, z` unit-edge anchor. Start and end are inclusive, so a one-square wall reports the same coordinate for both. `ArrowLeft` decreases that anchor's run-axis coordinate by one; `ArrowRight` increases it. The result announces only the authoritative new coordinate.
- `Slide vertically` / `Slide horizontally`: `ArrowLeft` or `ArrowRight` moves a horizontal run along y or a vertical run along x without changing its length.
- `Orientation`: `ArrowLeft`/`ArrowRight` cycles horizontal and vertical directly; `Enter` opens the shared option selector. Rotation keeps the start coordinate fixed and is rejected if the rotated run is outside the world or overlaps another wall.
- `Type`: This is the first wall action. `ArrowLeft`/`ArrowRight` cycles presets directly; `Enter` opens the shared option selector. Choosing a preset resets title, movement behavior, height, transmission, low-pass, and contact sound to that preset's defaults.
- `Edit properties`: Change sound transmission (`0..1`), occlusion low-pass (`20..20000` hertz), or the contact-sound URL.
- On transmission or low-pass, `ArrowLeft`/`ArrowRight` changes one numeric step and `PageDown`/`PageUp` changes ten steps. Inside the numeric editor, use `ArrowDown`/`ArrowUp` and the corresponding page keys.
- `Space`: Read specific help for the selected World Builder action, preset, direction, or wall. Property help uses shared metadata to report its type, options or numeric range, and editability.
- Edit walls > select wall > Doors lists its attached doors. Add door selects an unused unit edge by number and coordinates. A wall can have multiple doors. Sliding and rotating moves them with the wall. Remove a door before trimming away its edge.
- Door settings uses the World Builder controls. Up/Down selects a property, Left/Right adjusts an option or timeout, Enter edits a value or opens its option list, and Escape goes back. Choosing Keypad and confirming its PIN arms the lock. An open door stays open and requires the PIN on its protected side after it closes. Keypad mode adds a four-digit PIN, keypad side(s), Require PIN for (Unlock by default, Lock, or Both), and an unlock timeout of 0 to 300 seconds. A newly configured keypad defaults to 10 seconds. Zero keeps the door unlocked until manually locked. Expiry arms the lock even if the door is open; passage remains possible until it closes.
- Walls are edited live. Other connected clients receive and render changes immediately.
- `Add region` creates a one-square region at your current tile. `Edit regions` lists existing regions on this floor. Both actions are in the World Builder menu alongside the ambiance actions. Edit its name with Enter, adjust Start X/Y and End X/Y with Left/Right, or slide its complete rectangle with Slide X/Y. Deletion uses the default-No confirmation. Regions may overlap and have no audio settings.
- `C` reads coordinates first, then every containing named region from smallest inclusive area to largest, then the platform name. For example, inside a closet within a studio on the Main floor it reads `x, y, z, Closet, Studio, Main floor`. Adjacent wall information follows the location when present. Other location readouts use the same coordinates, regions, then platform order.
- Wall deletion uses the same default-No confirmation flow as item deletion; confirmation choices do not have tooltips.
- Brick, glass, and fence walls block movement. Curtains may be crossed; wall impacts and curtain crossings play the structure's contact sound locally and spatially for nearby users.
- New curtain, glass, and fence walls use their matching contact sounds; brick uses the standard wall sound. Builders may edit any wall's sound URL.

### Audio

The number-key audio toggles act once per press; holding a key does not toggle repeatedly.

- `P`: Ping server
- `V`: Set microphone gain
- `Shift+V`: Microphone calibration
- `M`: Mute/unmute local microphone
- `Shift+M`: Toggle stereo/mono output
- `Shift+1` (`!`): Toggle loopback monitor
- `1`: Toggle voice layer
- `2`: Toggle item layer (emit sounds)
- `3`: Toggle media layer (radio)
- `4`: Toggle world layer (other-user world sounds and ambiances)
- `Shift+4`: Toggle HRTF spatial audio (saved per browser; standard mode is the default)
- `Shift+E`: Effect select menu in standard or HRTF mode
- `-` / `=`: Lower/raise master volume
- `_` / `+` (`Shift+-` / `Shift+=`): Lower/raise active effect value

## Text Entry Modes (`nickname`, `chat`, `itemPropertyEdit`, `worldBuilderPropertyEdit`)

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

Applies to effect select, user/item list modes, item selection, item property list, and the shared option selector.

- `ArrowUp` / `ArrowDown`: Move selection
- `PageUp` / `PageDown` in item property list: Jump 10 values for left/right-editable option fields
- `PageUp` / `PageDown` in the option selector: Jump 10 options backward/forward
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

## Users Menu

- `Shift+Z`: Open users
- `Space` on root actions: Read tooltip/help for the selected action
- Menu options are permission-gated and include:
  - list registered users with role, account status, and online/last-seen presence (`user.list`; built-in user, editor, and admin roles)
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

### Platforms (World Builder)

- Choose **Platforms** to browse every elevation or **Add platform** to enter a new flat rectangle. Creating a platform opens an unsaved draft at your position. Set its Name, Start X/Y, End X/Y and Elevation, then choose **Create platform**. This permits coordinate entry for disconnected islands and new elevations.
- Use the shared property controls. `Up`/`Down` browse rows, `Left`/`Right` adjust coordinates by one, and page keys adjust by ten. `Enter` opens text entry, where `Up`/`Down` step the value. `Space` reads the selected property's tooltip and range. Signed integer coordinates range from -1,000,000 to 1,000,000.
- Existing platform edits are validated and saved by the server. Only the accepted property value is announced. Reversed corners are normalized. Platforms may touch, and platforms at different elevations may share X/Y coordinates. Same-height overlaps are rejected. Disconnected platforms are allowed.
- **Footsteps** selects the platform's walking sounds, starting with **Default**. Use Left/Right to change the sound set or Enter to open the shared options list. Space reads help. After the server accepts a change, only the selected sound set's name is announced.
- **Delete platform** uses the shared confirmation controls. Deleting or shrinking a platform moves anyone whose square loses support to `0, 0, 0` if it is supported, or to the lowest X/Y corner of the first remaining platform. People on retained squares stay in place. Placed items and required landings can block the change, and at least one platform must remain. A rejected edit announces the server's reason. `Escape` returns to the previous menu or cancels text entry.

### Ambiance editor (World Builder)

- `Add ambiance` / `Edit ambiances`: Create at your current square or select a region on this floor. Both open the same editor, with Type first.
- `Up` / `Down`: Browse Type, Name, start/end X and Y, horizontal/vertical slide, Volume, Fade distance, and Delete.
- `Left` / `Right`: Adjust the selected edge, slide, type, or numeric property. `Enter` opens a type selector or name/numeric entry; `Space` reads its tooltip and controls.
- `Escape`: Cancel text/selection or return to the previous menu. Deletion uses the shared confirmation dialog.
- World audio layer (`4`): Includes ambiance loops. `Shift+4` changes HRTF as usual.
- Value adjustments play one confirmation when accepted by the server. Pressing past an existing numeric limit plays only the boundary sound.
