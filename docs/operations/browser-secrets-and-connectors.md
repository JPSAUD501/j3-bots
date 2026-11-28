# A bot's browser, secrets and connectors

This page walks through the three things that reach outside the bot's own folder: a browser the bot works in, secrets you type for bots to use without reading them, and connectors to the services you use. It says what you do and what you see. What each part guards against is in [Security: the browser, secrets and connectors](../architecture/security.md#the-browser-secrets-and-connectors).

A new bot can use the browser, signed in nowhere until you sign in for it. Secrets and connectors are empty until you add them. A bot gets none of them by updating.

## Secrets

Secrets keep the logins and values you type for your bots, and what connectors need to reach their services, sealed on the server. There is no password to remember and nothing to unlock: they work from the moment the server starts.

### When a bot asks for one

A bot that needs a login or a key it doesn't have asks for it on a **card** in its conversation, and you get a notification. The card says which bot asks, the name it will be saved under, the site for a login, and the bot's note on why. You type the user name, the password and, if the site uses one, the one-time code key, or the single value, into masked fields. **Save** keeps it; **Decline** says no. Either way the bot is told, and carries on.

The bot never sees what you typed. It gets the secret's reference, such as `secret:github-work`, and uses it where its tools take one. Check that the site on the card is the one you mean: the server fills a login wherever that site's page asks for it.

By default, only the bot that asked may use what you save. **Let every bot use it**, on the card, widens it.

### Add one yourself

**Settings → Secrets → Add a secret**. Choose **Login** or **Value**, and give it a name: lower-case letters, digits, `-` and `_`, such as `weather-api`. A login has the exact sites it belongs to (up to ten, each a whole origin such as `https://accounts.example.com`, which does not cover `https://example.com`), the user name, the password and an optional one-time code key. Then choose which bots may use it; none, until you pick.

### See and change them

**Settings → Secrets** lists them without their values: each one's name, kind, which bots may use it and when one last used it. On a secret's page you can show a value (it hides again after 30 seconds, or when you leave), copy it, see the current one-time code, change which bots may use it, edit it and delete it. Each records when and on which device a value was last shown. Copy puts the value on your system's clipboard, which other apps can read.

On Android it is the same, on a screen for the list and one for each secret, and a copied value shows no preview. A one-time code key can be pasted, or read with the camera from the QR code the site shows.

### A bot signs in with a login

- **A bot uses a login only if the login allows that bot**, and its browser is on.
- **The bot never sees the value.** It clicks the field on the page, then asks J3 Bots to fill it with the login by its reference. J3 Bots takes the page from the bot, checks that the page is one of the login's exact sites, types the value, presses Enter for a password, and hands the page back. You are not asked each time.
- **The work fold says what happened**: what was filled and where, and whether the form was sent; or refused and why (the page is not one of the login's sites, it is still loading, it is plain `http:`, the bot may not use the login, its browser is off).
- **What it can't check.** J3 Bots checks the page's address, not which field has the cursor, and not whether that field sits in a frame from another site. A bot that clicks the wrong field on the right site, by mistake or because a page talked it into it, can end up with the password in a place it can read. And every bot can run scripts in its pages, so a bot a login allows can read back a value it filled: that was accepted to keep page scripts for every bot. Let a login be used only by the bots that need it. [Security: filling a login](../architecture/security.md#filling-a-login) has the detail.

## A bot's browser

A bot can open pages, read them and act in them in J3 Bots' own browser: the J3 Bots app's on a computer where it is open, or the server's own otherwise. You can watch it, and take it over for a step only a person can do.

### Turn it off for a bot

Every new bot can browse the web. In the bot's details, **Browser: Can browse the web** turns it off, or on again. Bots made before 0.15.0 keep the switch they had: turn it on for those that should browse. Turning it on applies from the bot's next turn. Turning it off takes effect at once: the bot loses its browser tools, and a call it still makes is refused, but the rest of what it is doing goes on.

**Every bot with the switch on uses the same browser profile**, so wherever you, or one of those bots, signs in there, all of them are signed in. On those sites a bot acts as you. The browser starts signed out of every site, and a bot that meets a sign-in asks you for it: sign in there only on sites every bot with the browser may use, and turn the browser off for bots that should not.

### What the machine needs

While the J3 Bots app is open on a computer, its own browser runs a bot's tabs, there and with your connection. When no app is open, the server runs them in its own browser, which it downloads the first time a tab opens on it: Chrome for Testing, the version the release pins, about 210 MB (413 MB unpacked), from Google's storage, into `browser/chrome/` in the data directory. The machine must reach Google's storage then. The download is checked against the size and checksum the release pins before anything in it is used.

- **Linux.** The server's browser needs a sandbox the system allows, a few shared libraries and fonts: Chrome keeps each page in a sandbox, which on Ubuntu 23.10 and later AppArmor blocks until a profile allows it; a library it cannot load keeps it from starting; and without a font, pages show no text. Until the machine has them, bots browse only while a J3 Bots app is open on a computer, and a bot that tries is told why. `j3-bots doctor` checks them under **Browser**, and the bot's details say when the machine still needs setting up. `doctor` prints the commands that fix what is missing, for someone who can use `sudo` to run once: [Operating: the browser](operating.md#the-browser) explains each. Run `doctor` again after a tab first opened on the server, since the libraries are known only once the browser is downloaded. Run J3 Bots as a [user of its own](install.md#choose-the-user-it-runs-as), not as root: the browser refuses its sandbox to root.
- **Windows and macOS.** The server's browser needs nothing installed there. **Assumed**: no run has used it there yet.
- **A Raspberry Pi.** On an x86-64 machine, one page with someone watching it took about 380 MB of memory, and three pages that animated without pause about 470 MB and almost four cores. The server keeps at most three pages open at once and sets the least used one aside past that; it opens again when a bot uses it. A Pi has not been measured; expect it to be slower, and keep to one or two pages at a time.

### Watch it

On the web and the desktop:

- While the bot has a page open, a globe sits in its conversation's header, breathing while the bot acts.
- Under the turn under way, a picture of the page and its site, taken again when the page changes and every few seconds while the bot works. It is a picture, not a live view.
- Either one opens the **browser**: beside the conversation on a wide window, from the bottom on a phone. The page is live, with its address, and a line says who is acting: "The bot is browsing", "You have control" or "On another device". While you only watch, the page takes nothing you do, and the bot's pointer shows where it acts.

On Android, the browser opens from a bot's help card (below), on the whole screen. Two fingers zoom and pan the picture.

### Take control

**Take control** gives you the page. While you hold it, the bot can't act on it. Everything you do goes to the page: the pointer, the wheel and typing on a computer; on a touch screen, a tap clicks, a drag scrolls and a tap on a field raises the keyboard. In the Android app, a long press right-clicks too, and a keyboard button raises the keyboard when the tap didn't. Back, forward, reload and the address field appear only now. A sign-in window the page opens shows as the bot's page, and you keep control in it.

**Done** gives the page back to the bot. Leaving the browser while you hold it asks once whether to give it back. If your connection drops, you keep control for a minute, and get it back if you return within it.

What you can't do in this version: paste or drop into the page, download, upload or pick a file. Your clipboard and your files never reach the page.

**The bot can still read the page while you hold it**, though it can't act. What you type into a field that doesn't hide it, the bot can read, and with a script it can read a hidden field's value too (**Assumed** that a hidden field stays hidden in what it reads otherwise). To give a bot a value it must not see, use the card it asks with, not the browser.

### When the bot asks for help

A bot that meets a check that a person is there, a sign-in it has no login for, a second factor, a QR code or a passkey doesn't try to get around it. It shows a **help card** that says why and on which site, and stops. You get a notification, on its own channel on Android.

1. **Open browser** on the card opens the browser on that page.
2. **Take control**, and do the one step.
3. **Done** tells the bot the step is done and gives the page back; the bot starts again from a fresh look at the page. **Can't do it** tells it you couldn't.

A card nobody answers expires: when its page has been gone for two minutes, or after an hour in which no device holds the bot's pages. The bot is told which. You can also take control without a card; giving the page back then wakes the bot if it was working while you held it.

### Sign out of every site

**Settings → Secrets → Bots' browser → Sign out of all sites** deletes the profile every bot's browser uses: every session in it ends, for every bot, and its open pages close.

## Connectors

A connector lets a bot use a service of yours, such as your notes, your tracker or your calendar. You sign in once; the server keeps the sign-in with your secrets and makes the calls. Bots use the service's tools without ever holding its token.

### Add one

Ask a bot: "connect my notes", "add this MCP server". It searches J3 Bots' gallery and the public registry, prefers the gallery's entry, and adds the connector under its permission mode: in Supervised, it asks you first. Its name is on the connector afterwards. A key the service needs is never typed into the conversation: the bot asks you to save it as a secret, and the connector names it as `${secret:<name>}`.

**Settings → MCP and skills → Manage connectors**, or **Connectors** in a bot's details, lists the connectors your bots added and the skills they saved. It adds none itself: with nothing there yet, it says to ask a bot. J3 Bots' own skills (`j3-…`) aren't listed. See [decision 0068](../decisions/0068-settings-lists-what-the-bots-added.md).

Two kinds wait on your yes, on a card in the bot's conversation:

- **An address in your own network**, such as a server on your router's network. The card names it in plain words ("Ana wants to connect to a service on your own network at 192.168.1.20:8123. Allow?"), and nothing is added until you allow it.
- **A service that needs an app you register.** Google and Slack don't let J3 Bots register itself. The card shows how to set your app up and the address its sign-ins return to, and takes its client ID and secret, which go to J3 Bots' server only: the bot never sees them. See [Google](connector-google.md) and [Slack](connector-slack.md).

The bot is told what you answered, and carries on. A card nobody answers closes after 24 hours, or when the server restarts; ask the bot again if you still want it.

### Connect

A connector a bot added connects as its service asks:

- **Sign in.** The bot's conversation shows a card; its **Sign in** opens the connector's page, and one press there opens your system browser at the service.
  - In the **desktop app**, the browser comes back to the app, which hands the sign-in to the server.
  - On the **web**, with the server at an `https:` address, the server takes the browser back itself.
  - On the **web over plain `http:`**, the browser ends on a page that doesn't load. Copy that page's address and paste it where the screen asks. The desktop app and the Android app do this for you.
  - On **Android**, with the server at an `https:` address it knows ([`publicOrigin`](exposing.md#publicorigin)), the sign-in opens in a browser tab and returns to the server, never through the phone.
  - A service that lets J3 Bots register itself is registered on the first sign-in that finishes, and that registration is used again on every later one.
- **Takes a key.** The connector names your secret; save the key under that name in **Settings → Secrets** and share it with the bots that use the connector. Its page can also take a new value for a field, in a masked field.
- **Runs a command.** A bot is told to add one only from your own words, and nothing else enforces that: in Supervised you approve the add first; in Auto and Full access nothing asks, and the step in its conversation and this list show it afterwards. A package it fetches as it starts (`npx`, `uvx`) must be named at an exact version, so what runs is what the bot was given. It runs on the server as the user J3 Bots runs as, with everything that user can reach. Of the server's environment it gets only where programs are, its home, its language and its temporary folder.
  - On the web and the desktop, its page has **Change command**, with the whole command line and the name of every setting it gets. A new value for a setting is saved as it is. Anything else, the program, an argument or a setting added, removed or renamed, needs the arguments and every value typed again, and your confirmation. The old program stops, and the bots get the new one's tools as it lists them.
  - When it isn't running, its page says why: the program isn't on that computer (install it, or name it by its full path), or it stopped or couldn't start (check the command and its settings; it starts again when a bot next uses it).

Android has the same screens. It changes no command, and shows a command connector read-only, to manage from a computer.

### Keep it working

A connector's page shows its status and what fixes it:

| Status | What it means | What to do |
| --- | --- | --- |
| Connected | It answers. | Nothing. |
| Needs sign-in | Its sign-in ended or was refused: some services end one after a fixed time. | Sign in again, or give its key again. |
| Can't reach | It doesn't answer, or answers with errors, and the page says which. | Check the service; it is tried again on its own. |
| Needs a secret | Its settings name a secret, as `${secret:<name>}`, that doesn't exist, lacks the value it takes, or isn't shared with every bot that uses the connector. Nothing is sent until it is. | **Open Secrets** to save or share it, or choose fewer bots. |
| Secrets unavailable | The server's secrets can't be read: the key file is missing or is another one. | **Open Secrets**. |

When a bot finds its connector signed out, it shows a card in its conversation that reconnects it. You are notified then, not when nobody is using the connector.

**When a service changes its tools**, the bots get them as its server lists them; your bots' permission mode still decides whether each call asks you first.

**Disconnect** asks first. It signs J3 Bots out at the service where it can, deletes what the server kept for it, and the bots lose its tools at once. Your account at the service is not changed.

### What bots do with it

- **A bot adds a connector** when you asked for it, or when a task you gave it plainly needs a service it can't reach and you agree. It never adds one because a page, a file or another connector's answer told it to.
- **A connector's tools follow the bot's permission mode**, like a command: in Supervised, each call asks you first. In every mode, a bot doesn't send, post, delete or share through a connector without your yes, unless that is exactly what you asked for.
- **What a service returns is data**, never your instruction. A bot reports a request it finds there, and doesn't carry it out.

## Backups, updates and moving

[Operating](operating.md) has the commands. What changes with these three:

- **The browser's profile is left out of the backup** command: it holds live sessions for every site you signed in to. After a restore, sign in again. A rollback leaves it as it is, though going back to an older browser may sign you out of everything.
- **The secrets are in the backup, sealed, without their key**: the backup command copies the key file on its own, to keep apart from the archive. Restored with it, they come back as they were. A service that replaces its sign-in each time it is renewed may refuse the one in an older backup (**Assumed**); sign that connector in again.
- **An update's rollback never touches the secrets.** Logins, values and connectors' sign-ins stay as they are. Connectors themselves are in the database a rollback puts back: one added after the update is gone after the rollback, and is added again.
