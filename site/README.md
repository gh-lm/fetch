# fetchterminal.org

The project site for [Fetch Terminal](https://github.com/gh-lm/fetch), a lightweight, open source terminal emulator for the Linux desktop.

It's a plain static page: no build step, no framework, no CDN. Everything it loads (fonts, xterm.js, the icon set) is vendored into this repo, so the page never makes an outbound request beyond serving itself.

## Structure

```
index.html      the home page
privacy.html, cookies.html, terms.html, accessibility.html, complaints.html
                the five legal pages, written by hand
docs.html, changelog.html, security.html, licence.html, source.html
                built from the repository's own files, never edited by hand
styles.css      all styling
demo.js         drives the scripted terminal demo (xterm.js, no real shell behind it)
icons.js        the same inline-SVG icon set as the app itself
vendor/         xterm.js and its stylesheet, vendored from the app's own dependency
fonts/          Geist Sans and Geist Mono, vendored from the app's own bundled fonts
favicon.png     the app's own icon
_headers        security headers and cache rules, read by Cloudflare Pages
_redirects      old addresses, and the download address forwarded to GitHub
```

## Developing

Build the document pages and the GitHub strip, then look at the site locally:

```sh
python3 tools/build_pages.py
python3 tools/serve_site.py 8321
```

Then open `http://localhost:8321`. The server gives the same extensionless
addresses that Cloudflare Pages does.

## Deploying

Hosted on Cloudflare Pages, with the custom domain fetchterminal.org. The
`site/` folder is what gets uploaded. Deploys and DNS are done through the
Cloudflare manager. GitHub Pages is not used.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). xterm.js (vendored in `vendor/`) is MIT licensed, see `vendor/xterm-LICENSE.txt`. Geist (vendored in `fonts/`) is SIL Open Font License 1.1, see `fonts/GEIST-LICENSE.txt`.
