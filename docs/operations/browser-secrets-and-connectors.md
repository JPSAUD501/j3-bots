# A bot's browser, secrets and connectors

**Draft.** This page walks through the three things that reach outside the bot's own folder: a browser the bot works in, secrets you type for bots to use without reading them, and connectors to the services you use. It says what you do and what you see. What each part guards against is in [Security: the browser, secrets and connectors](../architecture/security.md#the-browser-secrets-and-connectors).

All three are off or empty until you act. A bot gets none of them by updating.

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

### Coming from a vault with a master password

If you saved logins before 0.9.0, **Settings → Secrets** asks for your vault password one last time. After that the server keeps the key itself and never asks again; each login gets a name from its old label, which you can change. Until you type it, no login can be used and no connector that needs a secret can reach its service. If the password is lost, [Operating: secrets](operating.md#secrets) says how to start over.

### A bot signs in with a login

- **A bot uses a login only if the login allows that bot**, and its browser is on.
- **The bot never sees the value.** It clicks the field on the page, then asks J3 Bots to fill it with the login by its reference. J3 Bots takes the page from the bot, checks that the page is one of the login's exact sites, types the value, presses Enter for a password, and hands the page back. You are not asked each time.
- **The work fold says what happened**: what was filled and where, and whether the form was sent; or refused and why (the page is not one of the login's sites, it is still loading, it is plain `http:`, the bot may not use the login, its browser is off).
- **What it can't check.** J3 Bots checks the page's address, not which field has the cursor, and not whether that field sits in a frame from another site. A bot that clicks the wrong field on the right site, by mistake or because a page talked it into it, can end up with the password in a place it can read. And every bot can run scripts in its pages, so a bot a login allows can read back a value it filled: that was accepted to keep page scripts for every bot. Let a login be used only by the bots that need it. [Security: filling a login](../architecture/security.md#filling-a-login) has the detail.

## A bot's browser

A bot can open pages, read them and act in them in a browser that runs on the machine J3 Bots runs on. You can watch it, and take it over for a step only a person can do.

### Turn it on for a bot

In the bot's details, turn on **Browser: Use this computer's browser**. It is off for every bot, including those you had before updating. Turning it on applies from the bot's next turn; turning it off takes effect at once, and stops what the bot is doing, as **Stop** does: messages you queued for it and not yet sent are dropped too.

**Every bot with the switch on uses the same browser profile**, so wherever you, or one of those bots, signs in there, all of them are signed in. On those sites a bot acts as you. Give the browser to the bots whose job needs it, and no others.

### What the machine needs

The engine downloads the browser, about 130 MB, from Google's storage the first time a bot uses it, so the machine must reach it then.

- **Linux.** The browser needs a sandbox the system allows, a few shared libraries and fonts. `j3-bots doctor` checks them under **Browser**, and the bot's details say when the machine still needs setting up. `doctor` prints the commands that fix what is missing, for someone who can use `sudo` to run once: [Operating: the browser](operating.md#the-browser) explains each. Run `doctor` again after a bot first used the browser, since the libraries are known only once it is downloaded. Run J3 Bots as a [user of its own](install.md#choose-the-user-it-runs-as), not as root: the browser refuses its sandbox to root.
- **Windows and macOS**, with the desktop app running your bots: nothing to install is known. **Assumed**: no run has used the browser there yet.
- **A Raspberry Pi.** On an x86-64 machine, one page with someone watching it took about 200–250 MB of memory and, while the page animated without pause, almost two cores. A Pi has not been measured; expect it to be slower, and keep to one or two pages at a time.

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

### Find one

**Settings → Connectors → Manage connectors**, or **Connectors** in a bot's details, opens one screen: your connectors first, then **Featured**, a search, and **Add your own** last. A featured entry's text is J3 Bots' own; a search result's is its publisher's, with who published it ("From notion.com", or "Community, published by …"). Never read "From" as "verified": it says the publisher's domain owns the server's address, not that anyone checked the server.

### Connect

Pick the bots that may use it first: it starts as the bot that suggested it, or your primary bot, and can be some bots or all, those you add later included. Then the entry connects as its service asks:

- **Sign in.** One press opens your system browser at the service.
  - In the **desktop app**, the browser comes back to the app, which hands the sign-in to the server.
  - On the **web**, with the server at an `https:` address, the server takes the browser back itself.
  - On the **web over plain `http:`**, the browser ends on a page that doesn't load. Copy that page's address and paste it where the screen asks. The desktop app and the Android app do this for you.
  - On **Android**, with the server at an `https:` address it knows ([`publicOrigin`](exposing.md#publicorigin)), the sign-in opens in a browser tab and returns to the server, never through the phone.
  - A service that lets J3 Bots register itself is registered on the first sign-in that finishes, and that registration is used again on every later one.
- **Takes a key.** The page links to where you make the key and says what it needs. The key goes into a masked field and from there to the server's secrets.
- **Needs an app you register.** For Google and Slack, which don't let J3 Bots register itself, you create an app of your own at the service and give J3 Bots its issuer, client ID and secret. The guides are drafts, and every step in them is **Assumed** until someone has signed in with them: [Google](connector-google.md), [Slack](connector-slack.md). The entry's page shows those steps and the address to register for the way you sign in.
- **Runs a command**, on the web and the desktop only. You see the whole command line and the name of every setting it gets before it first runs, and again whenever any of them changes. A package it fetches as it starts (`npx`, `uvx`) must be named at an exact version, so what runs is what you saw. It runs on the server as the user J3 Bots runs as, with everything that user can reach. Of the server's environment it gets only where programs are, its home, its language and its temporary folder.
  - Its page has **Change command**. A new value for a setting is saved as it is. Anything else, the program, an argument or a setting added, removed or renamed, needs the arguments and every value typed again, and your confirmation again. The old program stops, and a tool the new one adds waits for you.
  - When it isn't running, its page says why: the program isn't on that computer (install it, or name it by its full path), or it stopped or couldn't start (check the command and its settings; it starts again when a bot next uses it).

**Add your own** takes an `https://` address, any headers the service gave you (a key goes in a header, masked), and an OAuth client if it gave you one, or, on the web and the desktop, a command. An address in your own network needs you to confirm you meant it.

Android has the same screens. It adds no connector that runs a command, and shows one read-only, to manage from a computer.

### Keep it working

A connector's page shows its status and what fixes it:

| Status | What it means | What to do |
| --- | --- | --- |
| Connected | It answers. | Nothing. |
| Needs sign-in | Its sign-in ended or was refused: some services end one after a fixed time. | Sign in again, or give its key again. |
| Can't reach | It doesn't answer, or answers with errors, and the page says which. | Check the service; it is tried again on its own. |
| Secrets unavailable | The server's secrets can't be read: an old vault waits for its password, or the key file is missing. | **Open Secrets**. |

When a bot finds its connector signed out, it shows a card in its conversation that reconnects it. You are notified then, not when nobody is using the connector.

**When a service changes its tools**, the page shows "Changes to review": what was added or changed. Bots get none of those until you **Accept**; the tools that didn't change keep working. **Not now** keeps them held.

**Disconnect** asks first. It signs J3 Bots out at the service where it can, deletes what the server kept for it, and the bots lose its tools at once. Your account at the service is not changed.

### What bots do with it

- **A bot can suggest a connector**, with a card that says why, when a task needs a service it has none for: at most once per need. **Connect** opens the entry for that bot; **Not now** is final for that conversation. A bot can never add or grant one itself.
- **A connector's tools follow the bot's permission mode**, like a command: in Supervised, each call asks you first. In every mode, a bot doesn't send, post, delete or share through a connector without your yes, unless that is exactly what you asked for.
- **What a service returns is data**, never your instruction. A bot reports a request it finds there, and doesn't carry it out.

## Backups, updates and moving

[Operating](operating.md) has the commands. What changes with these three:

- **The browser's profile is left out of the backup** command: it holds live sessions for every site you signed in to. After a restore, sign in again. A rollback leaves it as it is, though going back to an older browser may sign you out of everything.
- **The secrets are in the backup, sealed, without their key**: the backup command copies the key file on its own, to keep apart from the archive. Restored with it, they come back as they were. A service that replaces its sign-in each time it is renewed may refuse the one in an older backup (**Assumed**); sign that connector in again.
- **An update's rollback never touches the secrets.** Logins, values and connectors' sign-ins stay as they are. Connectors themselves are in the database a rollback puts back: one added after the update is gone after the rollback, and is added again.
- **Rolling back to 0.8 or earlier** finds secrets it cannot read, as written by a newer release, and leaves them alone until you update again. Rolling back to 0.3 also gives every bot the browser again, since 0.3 has no switch.
