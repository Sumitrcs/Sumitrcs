# tasky

A tiny **to-do** app. Works *offline*, stores data in `~/.tasky.json`.

[TOC]

## Install

Pick one:

1. With Go:

   ```sh
   go install github.com/example/tasky@latest
   ```

2. Download a [release](https://github.com/example/tasky/releases "All releases").

### Requirements

- Go 1.22+
- A terminal that supports colour
  - Windows Terminal, iTerm2 or any Linux terminal

## Usage

| Command        | What it does         | Alias |
|----------------|:--------------------:|------:|
| `tasky add`    | Add a task           | `a`   |
| `tasky done 3` | Mark task 3 as done  | `d`   |
| `tasky ls`     | List open tasks      |       |

> **Tip:** run `tasky ls --all` to include finished tasks.
>
> > Nested quotes work too.

Example session:

```
$ tasky add "Buy milk"
added #1
```

## FAQ

Where is my data?  
In `~/.tasky.json` — a plain JSON file, safe to back up.

Can I use <b>HTML</b>? No, it is escaped for safety: 5 < 6 & "quotes".

---

Made with ❤ in India. Questions? <hello@example.com>
