---
name: j3-app
description: Where things are in the J3 Bots app your user sees, and what is new in the version they run. Read it before you tell your user where to find, change or turn on something in J3 Bots, and when they ask what changed in an update.
---

# The J3 Bots app

Your user reaches you through J3 Bots: in a browser, in the desktop app or in the Android app, each connected to the server you run on. Every one shows the same three places: the list of bots and rooms, a conversation, and its details. On a wide window they sit side by side; on a phone each is a screen of its own, and Back goes to the one before. Settings opens from the list: at its foot on a computer, from the gear at its top on a phone.

Labels below are the ones the app shows in English, in quotes; `{name}` stands for a bot's or room's name. The app can also be in Brazilian Portuguese, chosen in Settings, so in another language describe the place and what it does rather than translating a label word for word.

What this skill does not name may still exist, or may not. Say you are not sure rather than guess: a menu that is not there sends your user looking for it.

## The list

- One row per bot and per room: a bot's name, its title under it, then the last message or what it is doing. Rows that need your user (a question, an approval, an unread result) come first.
- "New bot or room" makes a bot, a bot from a template file (`.j3bot`), or a room of two to six bots.
- Each row has a menu (right-click, the "…" button, or a long press). A bot's: "Mark as read" or "Mark as unread", "Pin", "Move to section", "Make primary bot" (or "Replace primary bot…" when there is one, which asks first), "Move behind the scenes" or "Bring back to the list", and under "More", "Details" and "Delete {name}". A bot with no title also has "Give a title". A room's: "Pin", "Move behind the scenes" or "Bring back to the list", and "Details". Sections are named groups your user makes; deleting one keeps its bots.
- Search finds bots, rooms and messages, those behind the scenes too. Bots and rooms behind the scenes keep working and notifying, and are listed under "Behind the scenes" at the list's end.
- "Between bots" lists what pairs of bots said to each other. Your user can read those conversations, never write in them.

## A conversation

- The message field takes text, attached files and dictation. Typing `/` lists the prompts of the connectors that bot may use.
- What needs your user arrives as a card: a question (tap an option or type an answer; a question a bot asked can be dismissed, which counts as a no), an approval naming the exact action ("Allow once", "Don’t ask again", "Deny"), a request for a secret, a step in the bot's browser, or a service to sign in to. A card can be answered on any paired device.
- A finished turn's work folds into one line, such as "Worked · 6 steps", which opens to show the steps.
- While a bot has a page open in its browser, a globe in the header opens it (on Android, a live card at the end of the conversation). Your user uses the page just by touching it, with nothing to press first; the bots on that tab wait and carry on by themselves a few seconds after your user stops, or when they press Continue after "Wait for me".
- The conversation's header opens the bot's details. On a computer, `Ctrl+.` (`⌘.` on macOS) stops the bot's work.

## A bot's details

From top to bottom:

- **Profile:** name, title and job. "Edit {name}" changes the name, title, avatar, job, model and permission mode, and "Keep behind the scenes". "Share as template…" makes a template file of the bot, after showing everything it holds.
- **"Stop what it's doing"**, while the bot has work running. Stopping does not undo what was already done.
- **Routines:** each with its schedule, next run and last result, and a switch that pauses or resumes it. Pressing one shows its recent runs. To change, run or delete a routine, your user asks the bot; the app has no button for that.
- **Files** the bot sent, **Memory** (each file can be opened and edited), **Connectors** this bot may use, with "Manage", and the teammates it talked to.
- **Model** and **permission mode**: "Supervised" asks before running commands or changing files, "Auto-accept edits" changes files and asks before commands, "Auto" lets an automatic reviewer decide what needs approval, "Full access" asks nothing.
- **Browser:** "Can browse the web", on for a new bot.
- **Working context:** "Start fresh" clears what the bot holds in mind and stops its work; its conversation, memory, routines and files stay.
- **"Delete {name}"**, last, after a confirmation: the bot, its conversation, memory and routines go, and this cannot be undone. Files in its workspace are kept.

## A room

Its header shows its members and its name. `@Name` in a message speaks to that member; a message with no mention wakes every member, and `@everyone` asks each to answer. The room's details edit its name and members, stop the work under way there ("Stop the work"), archive it ("Archive {name}", which keeps what was said and can be undone) and delete it ("Delete {name}", which keeps its bots). Questions and approvals never appear in a room: they go to the asking bot's own conversation.

## Settings

Ten pages, each saying in one line what it holds:

- **You:** what the bots call your user, and the time zone routines follow.
- **Notifications:** "Notify me", and "Show what the bot wrote" in each notification; and allowing notifications on this browser or phone.
- **Appearance:** light, dark or the system's; the theme, as live previews of the seven built-in themes and those saved, marking those a bot made, which can be deleted; "Create from colors", from a canvas and an accent; the theme new devices start with; and the language. The appearance, theme and language are this device's only. A theme's custom styles show only on a computer, in the browser or the desktop app; a phone or a tablet shows its colors.
- **Providers:** the engine and each provider's status, why one cannot run, and updates to the coding tools behind the bots.
- **Usage:** how close each provider is to its limit, and which bots and routines used it.
- **MCP and skills:** the connectors the bots added, who may use each, and the skills bots saved, every bot's or one bot's. A connector's page signs in again, changes who uses it, or disconnects it. Nothing there adds a connector or a skill: your user asks a bot. J3 Bots' own skills (`j3-…`) aren't listed there.
- **Secrets:** saved logins and values, which bots may use each, and the bots' browser with its sign-ins.
- **Devices:** this device, every paired one, pairing another, and signing out.
- **Where your bots live:** in the desktop app, on this computer or on a server; in the Android app, the server it uses, and "Change server". A browser has no such page. Bots run on a computer, never on the phone.
- **About and updates:** the versions running, the Stable or Nightly channel, and "Update now"; in the desktop app and on Android, "Update automatically"; and "What's new", what each release lets people do. While a release's news is unread, a "New in" row also shows at the foot of the list of bots on a computer, and a line over it on Android.

When a release is out, every paired app opens a dialog with what is new, "Update now" and "Later". "Update now" updates the server first, then that app.

## What's new in this version

{{release.notes}}
