<p align="center"><img src="icons/icon128.png" width="96" alt="Larp Radar"></p>

<h1 align="center">Larp Radar</h1>

<p align="center">A free Chrome extension that flags larp, slop and fearmongering on X, Instagram and LinkedIn while you scroll, and pulls out the one real takeaway from each post.</p>

---

Every post you scroll past gets a colour and a label:

| Label | Colour | What it means |
|---|---|---|
| ⚡ News | blue | breaking news, an announcement or a factual update |
| ★ Gem | gold | genuinely useful, specific insight, or real work shown with evidence |
| 🎭 Larp | red | faked or overstated expertise, results, money or access; engagement bait |
| ⚠ Fear | purple | fearmongering: scary claims that are false, exaggerated or unsupported |
| ✕ Slop | grey | generic filler with no real information |

The card flashes in its colour when the label lands, then keeps a coloured border. Each post also gets a larp score from 0 to 100 and a one-line takeaway under the text. Click the label for a deep dive: what the post claims, which claims are backed, red and green flags, what to check before trusting it, and a box to ask your own questions about the post.

A counter in the bottom left shows how much of your feed is larp.

## Install (about 5 minutes)

You need Chrome, or a Chromium browser such as Brave, Edge or Arc.

1. Go to the [Releases page](../../releases/latest) and download `larp-radar-v….zip`.
2. Unzip it. You get a folder called `larp-radar`. Put it somewhere you won't delete it, because Chrome runs the extension from that folder.
3. Open `chrome://extensions` in the address bar.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and pick the `larp-radar` folder.
6. The settings page opens. Paste your OpenRouter key (next section), click **Save**, then **Test with a sample post**.
7. Refresh any X, Instagram or LinkedIn tabs you already had open.

Chrome will ask the extension for access to all sites. It needs that for one reason: Chrome only lets an extension take a screenshot of a tab with that permission, and the screenshot is how it reads Instagram reels and carousels. It only runs on X, Instagram and LinkedIn.

## Get an OpenRouter key

The extension is free. The AI it uses is not, so you bring your own key and pay OpenRouter directly for what you use.

1. Make an account at [openrouter.ai](https://openrouter.ai).
2. Add some credit.
3. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys) and paste it into the extension's settings page.

The key is stored only in your browser. It is never sent anywhere except OpenRouter.

In my own tests, Jev scored 4 posts for about $0.00006 and a deep dive cost under a fifth of a cent. Instagram costs more than X because each reel sends a few screenshots to a vision model.

## How it works

On X it reads the post text. Up to 8 posts at a time go to Jev (`typesafe/jev-1.13` on OpenRouter), a model that answers yes/no and multiple-choice questions very quickly, which picks the label and the larp score. Gemini 2.5 Flash writes the takeaway.

On Instagram most posts are reels and carousels with almost no text, so it reads the screen. When a post has been on screen for a second it takes a few cropped screenshots of the media. Gemini reads the on-screen text and describes what is shown, then Jev labels it.

On LinkedIn it reads the text, and falls back to screenshots for posts that are mostly an image or a video.

Every post is scored once and cached.

## Settings

Click the extension icon, or the counter in the bottom left, to open settings.

You can decide what happens to junk posts: just label them, dim them until you hover, or hide them behind a one-line bar you can click to show. A post counts as junk when its larp score is over your threshold (70 by default) or when its label is one you ticked (larp, fear and slop by default).

You can also switch the takeaway line off, and swap the models for any other OpenRouter model.

## What leaves your browser

Post text, the author's name, and cropped screenshots of the post's own image or video, sent to OpenRouter. It never runs on X messages or settings, Instagram DMs or account pages, or LinkedIn messaging. Nothing goes to me.

## Limits

It cannot hear audio, so a reel whose whole point is in the speech gets judged on its captions and on-screen text. It doesn't swipe carousels, so it judges whichever slide is showing. The label is a model's judgement of what the post shows, not proof. Instagram and LinkedIn change their pages often, so post detection can break after a site update. If it does, open an issue.

## For developers

```sh
npm run check   # live test against OpenRouter, needs OPENROUTER_API_KEY
npm run zip     # builds dist/larp-radar-v<version>.zip for a release
```

There is no build step. Edit the files, then hit reload on the extension card in `chrome://extensions`.

Inspired by [Nate Herk's Jev feed tagger](https://x.com/nateherk/status/2101330780702068969).

MIT licence.
