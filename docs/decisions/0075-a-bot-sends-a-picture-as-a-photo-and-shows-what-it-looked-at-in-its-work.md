# 0075: A bot sends a picture as a photo, and shows an image it looked at in that step of its work

**Status:** Accepted.

## Context

A bot meets images two ways. It makes or finds one for the operator: a chart it drew, a screenshot of a page, the logo draft it picked. And it looks at one while it works: it reads a screenshot to see what a page shows, or a photo the operator sent.

Before this change the first arrived as a file card with a name and a size, the same as a spreadsheet, so the operator had to open it to see it; and the bot, told nothing about images, often described one in words or gave its path, which the operator's devices cannot open. The second left no trace the operator could see: the work fold said "Read chart.png" and nothing more.

The engine reports, with a step, the path of an image file the harness read: `dynamic_tool.viewedImagePath`, set from the path argument of Claude Code's `Read` of an image file, of Codex's `imageView` and of the ACP and Pi read tools, for the extensions its clients preview (**Read**, T3 Code `59651c1`, `ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`). It is a path on the machine, which no client may be sent.

## Decision

**A picture for the operator is an attachment of the bot's message, drawn as a photo. An image the bot only looked at is a thumbnail inside that step of its folded work, opened large on a tap, and nowhere else.**

- **Sending.** Nothing new on the wire: `say`'s `attachments` already copy a workspace file into the attachment store. The base prompt and `say`'s description tell the bot to attach a picture it made or found for its user, under `files/`, rather than describe it, link it or give its path, and that a GIF, JPEG, PNG or WebP shows as a photo. Clients draw an image a message carries after its text as a photo in a fixed frame, cropped to fill it, and fall back to the file card when it cannot be drawn; a file the operator placed in their text stays there, as before.
- **Looking.** `engine-t3` carries the path with the step it came with (`viewedImage`), to the server only. The server keeps it, relative to the bot's workspace, under an opaque id (`work_images`), and sends the step to clients with `image: {id}` (`WorkStep.image`, an additive field: protocol 11 holds). A client asks for the image by that id (`GET /work-images/:id`, a paired device's bearer) and draws a thumbnail beside the step's text; a tap opens it in the image viewer.
- **Only what the bot may read.** The image must be in the bot's workspace, which also holds what the operator gave it (their files are copied there). The server reads it there each time it is asked, under the same containment as a file a `say` attaches, at most 10 MiB, and serves it only as what its first bytes are: a GIF, JPEG, PNG or WebP. A file named `.png` that holds a page or an SVG, a file that left the workspace or a link out of it is nothing. The client never sends a path; it could not name a file the server did not already tie to a step.
- **Where it shows.** Only in the fold of the turn that looked at it. A turn's work folds into the bot's own conversation, a room turn's too, and a room shows no fold, so nothing a bot looked at reaches a room. The client draws the image the server serves, bounded by the frame; the server makes no thumbnail.

## Costs

- **It shows the file as it is now.** The server does not copy what the bot looked at, so a file the bot later changed shows its new content, and one it removed shows as unavailable. Copying every image every step reads would fill the attachment store with what nobody asked to keep; a picture the operator should keep is one the bot attaches.
- **A whole image for a thumbnail.** A device downloads up to 10 MiB to draw a 64-point square. Making thumbnails on the server would need an image decoder in it, a large surface for files a bot wrote; the frames are drawn only when a fold is opened, and a client keeps what it fetched.
- **Only what a harness reads as an image file.** An image that only exists in a tool's output, such as a browser screenshot returned inline, has no path and shows no thumbnail. The engine does not report it with the step.
- **The prompt asks; it cannot make sure.** A bot can still describe an image instead of attaching it. The eval cases grade it, and the operator can ask.

## Rejected

- **Copy each looked-at image into the attachment store.** It would keep exactly what the bot saw, at the price of storing every screenshot a turn reads, for a thumbnail the operator rarely opens. Serving the workspace file under the same checks keeps the store for what was sent.
- **Send the path and let the client fetch it, or serve any workspace path a client names.** A path is the server's to resolve; a client that names one could read any image in the workspace, or probe outside it.
- **Show looked-at images in the conversation.** The operator asked to see what the bot sent, not every frame it read on the way; in the fold they are where the work is.
- **A new message part or tool for images.** `say`'s attachments already carry files from the workspace with containment and limits. An image is a file the client draws differently.
