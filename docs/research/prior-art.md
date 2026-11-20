# Prior art

J3 Bots is not the first product of its kind. This document records what it learns from, and how that material is handled.

## xAI's Grok Bot

The clearest existing design for persistent AI teammates. What follows comes from its public documentation at `docs.x.ai/grok-bot` and from xAI's design article "Designing Grok Bot for a world of persistent agents" (September 2026).

**The product model**

- The durable object is a named bot, not a chat. A bot has a name, an avatar, a title, a conversation, a memory and routines.
- Personal bots have no settings form. The operator states the job in the first message and the bot remembers it.
- A bot starts work from one of three things: a message, a routine, or another bot.
- One bot can be primary: the default contact that checks in and coordinates the others.
- Memory is per bot. A few facts about the user are shared. The bot decides what to remember.
- Tools and skills are shared across bots; memory and routines belong to one bot. In the article's words, capabilities are shared broadly while context stays with the role that needs it.
- Group chats hold two to six bots. Mentioning a bot assigns an owner. Approvals and secret requests do not appear in groups.
- Bot-to-bot messages are asynchronous and visible. Every reply spends usage.
- Only the user's own messages count as instructions. Sends to other people are drafts until the user approves.

**The interface**

- The sidebar is a roster. Each row carries a one-line status.
- The avatar carries state through motion; a generic progress indicator was rejected because it could not distinguish working from stuck.
- The transcript mixes prose, system events and interactive cards in one timeline.
- Routines live in the bot's main interface, not in configuration.
- Dashboards, assignment boards and explicit handoff controls were considered and rejected as coordination work for the user.

**Limits its documentation states**

- Fifty bots and group chats together; fifty routines per bot; schedules at least five minutes apart; twenty run records kept per routine.
- Its documentation warns that frequent routines can spend a week of usage in a day.

**Where J3 Bots differs on purpose**

| Grok Bot | J3 Bots |
| --- | --- |
| Hosted, with its own subscription | Self-hosted, on subscriptions the operator already has |
| The model is not selectable | A model per bot |
| A shared cloud computer with a browser the user can watch | The operator's own machine; no managed desktop |
| A catalog of connected apps | The harness's own tools, plus what the operator installs |
| In a group, bots decide among themselves who answers | A host answers unaddressed messages, so one bot wakes per message |
| Memory stored by the service | Memory as files the operator owns |

## The unofficial prompt capture

A third-party repository circulates what it presents as a capture of Grok Bot's system prompt, tool definitions and skills. It is unofficial and unconfirmed.

It was read once during research, to understand which mechanisms such a product needs: how turns are framed, how non-user turns are marked, how speech is separated from scratch text, how routines report.

How it is handled in this project:

- **No text from it is copied** into J3 Bots' prompts, tool descriptions or documentation. J3 Bots' prompts are written from scratch, in different words, for different tools and constraints.
- **It is not stored in this repository**, and must not be added.
- Mechanisms are not anyone's property: marking who started a turn, delivering speech through a tool, keeping a small pinned memory. J3 Bots adopts mechanisms. It does not adopt wording, product-specific rules or names.
- Contributors should write prompt changes from J3 Bots' own behavior evals and their own judgment, not from that capture.

## T3 Code

J3 Bots' engine, and its reference for engineering practice. See [T3 Code as an engine](t3-code.md) and [Engineering standards](../engineering/standards.md). Its interface is one of J3 Bots' two design references; see [Design language](../design/design-language.md).

## Others worth studying

- **OpenClaw** and **Hermes Agent**: self-hosted personal agents reached through messaging apps. Different shape (one agent, many channels) but relevant for memory, scheduling and channel design.
- **Poke** and similar messaging-first assistants: relevant for tone and brevity.
