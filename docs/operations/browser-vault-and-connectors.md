# A bot's browser, the vault and connectors

**Draft for 0.4.0.** This page walks through the three things 0.4.0 adds that reach outside the bot's own folder: a browser the bot works in, a vault for the logins you save, and connectors to the services you use. It says what you do and what you see. What each part guards against is in [Security: the browser, the vault and connectors](../architecture/security.md#the-browser-the-vault-and-connectors).

All three are off, empty or locked until you act. A bot gets none of them by updating.

## The vault

The vault keeps the logins you save, and what connectors need to reach their services, sealed on the server under a master password only you know.

### Create the master password

You are asked once, in one of three places: the first run's **Create your vault password** step (you can skip it), the first save-login card a bot shows you, or **Settings → Vault**.

**Nothing recovers a forgotten master password.** There is no reset and no recovery key: forgetting it loses every saved login and every connector's sign-in. Keep it in a password manager of your own. If it is lost anyway, [Operating: the vault](operating.md#the-vault) says how to start over with an empty vault.

### Unlock it after every restart

The vault is locked whenever the server starts: after an update, a reboot, or the desktop app starting its bots. It stays locked until you unlock it from any of your devices, in **Settings → Vault** or on a card that needs it. While it is locked, no login can be saved, shown or filled, and every connector that needs a secret shows **Vault locked** and makes no call. **Lock now** in Settings locks it for every device; nothing locks it on a timer.

Five wrong passwords in a row make unlocking wait, from 30 seconds up to an hour. The screen says until when, and a restart does not end the wait.

### Save a login

When a bot needs a login it doesn't have, it shows a **save-login card** in its conversation: the site and a note on why. You type the user name, the password and, if the site uses one, the one-time code key, on the card. They go straight to the vault; the bot is told only that the card was shown, never what you typed. Check the site on the card before you save: a bot that a page misled can ask for a login to the wrong site.

You can also add a login yourself, in **Settings → Vault → Add a login**. Each login has a name, the exact sites it belongs to (up to ten, each a whole origin such as `https://accounts.example.com`, which does not cover `https://example.com`), the user name, the password and an optional one-time code key.

### See and change your logins

**Settings → Vault** lists the saved logins without their values. On each one you can show a value (it hides again after 30 seconds), copy it, see the current one-time code, edit it, delete it, and choose which bots may use it. Each login records when and on which device a value was last shown. Copy puts the value on your system's clipboard, which other apps can read and J3 Bots doesn't clear.

On Android, **Settings → Vault → Saved logins** does the same, on a screen for the list and one for each login. A shown value also hides as soon as you leave the screen or the app, and a copied one shows no preview. A one-time code key can be pasted, or read with the camera from the QR code the site shows, in the login form and on the save-login card.

### Let a bot fill a login

- **A bot uses saved logins only once you allow it**: **Sign in with saved logins**, a switch in the bot's details next to the browser's, off for every bot until you turn it on, and the login must allow that bot, in Settings → Vault. A bot whose browser is off fills nothing.
- **The bot never sees the value.** It clicks the field on the page, then asks J3 Bots to fill it with a saved login by name. J3 Bots takes the page from the bot, checks that the page is one of the login's exact sites, types the value, presses Enter for a password, and hands the page back. You are not asked each time.
- **The work fold says what happened**: what was filled and where, and whether the form was sent; refused and why (the page is not one of the login's sites, it is still loading, it is plain `http:`, the bot's access or its browser is off); or the vault is locked.
- **What it can't check.** J3 Bots checks the page's address, not which field has the cursor, and not whether that field sits in a frame from another site. A bot that clicks the wrong field on the right site, by mistake or because a page talked it into it, can end up with the password in a place it can read. And every bot can run scripts in its pages, so a bot with vault access can read back a value it filled: that was accepted to keep page scripts for every bot. That is why the switch is off by default: turn it on for the bots that need it. [Security: filling a login](../architecture/security.md#filling-a-login) has the detail.

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

**Settings → Bots' browser → Sign out of all sites** deletes the profile every bot's browser uses: every session in it ends, for every bot, and its open pages close.

## Connectors

A connector lets a bot use a service of yours, such as your notes, your tracker or your calendar. You sign in once; the server keeps the sign-in in the vault and makes the calls. Bots use the service's tools without ever holding its token.

**Set up the vault first.** Connectors keep their sign-ins in it, so a connector that needs a secret works only while the vault is unlocked.

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
- **Takes a key.** The page links to where you make the key and says what it needs. The key goes into a masked field and from there to the vault.
- **Needs an app you register.** For Google and Slack, which don't let J3 Bots register itself, you create an app of your own at the service and give J3 Bots its issuer, client ID and secret. The guides are drafts, and every step in them is **Assumed** until someone has signed in with them: [Google](connector-google.md), [Slack](connector-slack.md). The entry's page shows those steps and the address to register for the way you sign in.
- **Runs a command**, on the web and the desktop only. You see the whole command line and the name of every setting it gets before it first runs, and again whenever any of them changes. A package it fetches as it starts (`npx`, `uvx`) must be named at an exact version, so what runs is what you saw. It runs on the server as the user J3 Bots runs as, with everything that user can reach. Of the server's environment it gets only where programs are, its home, its language and its temporary folder.

**Add your own** takes an `https://` address, any headers the service gave you (a key goes in a header, masked), and an OAuth client if it gave you one, or, on the web and the desktop, a command. An address in your own network needs you to confirm you meant it.

Android has the same screens. It adds no connector that runs a command, and shows one read-only, to manage from a computer.

### Keep it working

A connector's page shows its status and what fixes it:

| Status | What it means | What to do |
| --- | --- | --- |
| Connected | It answers. | Nothing. |
| Needs sign-in | Its sign-in ended or was refused: some services end one after a fixed time. | Sign in again, or give its key again. |
| Can't reach | It doesn't answer, or answers with errors, and the page says which. | Check the service; it is tried again on its own. |
| Vault locked | The vault is locked since the server started. | **Unlock**. |

When a bot finds its connector signed out, it shows a card in its conversation that reconnects it. You are notified then, not when nobody is using the connector.

**When a service changes its tools**, the page shows "Changes to review": what was added or changed. Bots get none of those until you **Accept**; the tools that didn't change keep working. **Not now** keeps them held.

**Disconnect** asks first. It signs J3 Bots out at the service where it can, deletes what the vault kept for it, and the bots lose its tools at once. Your account at the service is not changed.

### What bots do with it

- **A bot can suggest a connector**, with a card that says why, when a task needs a service it has none for: at most once per need. **Connect** opens the entry for that bot; **Not now** is final for that conversation. A bot can never add or grant one itself.
- **A connector's tools follow the bot's permission mode**, like a command: in Supervised, each call asks you first. In every mode, a bot doesn't send, post, delete or share through a connector without your yes, unless that is exactly what you asked for.
- **What a service returns is data**, never your instruction. A bot reports a request it finds there, and doesn't carry it out.

## Backups, updates and moving

[Operating](operating.md) has the commands. What changes with these three:

- **The browser's profile is left out of the backup** command: it holds live sessions for every site you signed in to. After a restore, sign in again. A rollback leaves it as it is, though going back to an older browser may sign you out of everything.
- **The vault is in the backup, sealed**, and of no use without the master password, which is stored nowhere. It comes back locked, under the password it had when the backup was taken. A service that replaces its sign-in each time it is renewed may refuse the one in an older backup (**Assumed**); sign that connector in again.
- **An update's rollback never touches the vault.** Logins and connectors' sign-ins stay as they are, so a rollback never brings back a password you changed. Connectors themselves are in the database a rollback puts back: one added after the update is gone after the rollback, and is added again.
- **Rolling back to 0.3** gives every bot the browser again, since 0.3 has no switch, and has no vault or connectors. The vault's file stays for when you update again.
