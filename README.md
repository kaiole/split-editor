# split-editor

Edit pi prompts in your own editor in a tmux pane, while pi stays usable
beside it.

Press Ctrl+G in pi's prompt to open the prompt in your editor (`nvim` by
default) in a new tmux pane. pi keeps running and rendering in its own pane, so
you can read and browse the transcript while you write. When the editor exits,
the text comes back into pi's prompt.

## Demo

https://github.com/user-attachments/assets/47a81b03-8292-45b9-8c85-508719c5f585

## Requirements

- pi
- tmux (3.8 or later for floating panes, see [Layout](#layout))
- `nvim` by default; set the `editor` option to use a different terminal editor
  (see [Configuration](#configuration))

## Installation

From npm:

```bash
pi install npm:split-editor
```

From a local checkout:

```bash
pi install /path/to/split-editor
```

For development:

```bash
pi -e .
npm test # layout unit tests
```

## Usage

1. Start pi inside tmux with this package loaded.
2. Press Ctrl+G in pi's prompt.
3. Edit in the new pane, then quit the editor. How it exits decides what
   happens:

| Editor exit | Result |
| --- | --- |
| status 0 (`:wq`) | The text replaces pi's prompt. |
| non-zero (`:cq`) | pi's prompt stays as it was. |
| pane killed | pi's prompt stays as it was; if you had saved changes, pi says where the file was kept. |

While the editor is open, pi's prompt is locked:

- It shows an accent border naming the editor, its text dimmed, and no cursor.
- Typing there is ignored, including Enter and Esc, so a reflexive Esc does not
  abort the agent.
- Extension shortcuts (such as a transcript browser) and pi's view keys (expand
  tool output, toggle thinking, copy the last message) still work.
- Ctrl+G again goes to the editor pane.

## Layout

With `direction` set to `auto` (the default), each Ctrl+G picks a layout from
the size of pi's pane:

1. Side by side, when both pi and the editor get at least 80 columns.
2. Top/bottom, when both get at least 15 rows.
3. On tmux 3.8 or later, a floating pane over the largest strip of the window
   outside pi's pane. It may cover other panes, never pi's.
4. Otherwise a split in whichever direction leaves more room.

A zoomed pi pane is unzoomed first. `size` is the editor's share of a split.
Set `direction` to `h` or `v` to always split one way.

## Configuration

Configuration is read each time Ctrl+G opens the editor, so file and environment
changes apply without reloading the extension.

| Option      | Env var                  | Default | Description                                                    |
| ----------- | ------------------------ | ------- | -------------------------------------------------------------- |
| `editor`    | `SPLIT_EDITOR_EDITOR`    | `nvim`  | Editor command to run in the tmux pane.                        |
| `size`      | `SPLIT_EDITOR_SIZE`      | `50%`   | Editor share of a split, passed to `tmux split-window -l`.     |
| `direction` | `SPLIT_EDITOR_DIRECTION` | `auto`  | `auto` (see [Layout](#layout)), `h`/`horizontal` for side by side, `v`/`vertical` for top/bottom. |

Precedence, lowest to highest:

1. Defaults
2. Global config: `~/.pi/agent/extensions/split-editor.json`
3. Global pi settings: `~/.pi/agent/settings.json` under `splitEditor`
4. Project config: `.pi/split-editor.json`
5. Project pi settings: `.pi/settings.json` under `splitEditor`
6. Environment variables

Standalone config files use the options directly:

```json
{
  "editor": "nvim",
  "size": "50%",
  "direction": "auto"
}
```

Pi `settings.json` uses a `splitEditor` object:

```json
{
  "splitEditor": {
    "editor": "nvim",
    "direction": "v"
  }
}
```

## Notes

- Outside tmux, Ctrl+G falls back to pi's built-in external editor.
- The prompt file lives in a private temp directory (`pi-split-editor-*`) that
  is removed when the editor exits, unless it holds edits pi could not apply.
