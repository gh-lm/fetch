#!/usr/bin/env python3
"""Builds the website's document pages and the GitHub strip.

The README, changelog, security policy and licence live as files in the
repository because that is where people reading the source look for them.
The website needs the same words as HTML, so this script converts them into
the same shell as the legal pages, taking that shell from privacy.html so the
header and footers can never drift apart. It also puts the GitHub strip
above the legal footer on every page, once, from one template.

Run it from the repository root:  python3 tools/build_pages.py
"""

import hashlib
import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
TODAY = "2026-10-17"
REPO = "https://github.com/gh-lm/fetch"

LINK_MAP = {
    "./CHANGELOG.md": "/changelog",
    "./SECURITY.md": "/security",
    "./README.md": "/docs",
    "./LICENSE": "/licence",
    "./CONTRIBUTING.md": REPO + "/blob/main/CONTRIBUTING.md",
    "CHANGELOG.md": "/changelog",
    "SECURITY.md": "/security",
    "README.md": "/docs",
    "LICENSE": "/licence",
    "CONTRIBUTING.md": REPO + "/blob/main/CONTRIBUTING.md",
}


def esc(text):
    return html.escape(text, quote=False)


def inline(text):
    """Links, code spans, emphasis and bare autolinks.

    Links come out first so that a label containing a code span still becomes
    a link, and both are parked as placeholders so that escaping the plain
    text afterwards cannot touch the markup already built.
    """
    parts = []

    def stash(markup):
        parts.append(markup)
        return "\x00%d\x00" % (len(parts) - 1)

    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
                  lambda m: stash(_link(m.group(2), inline(m.group(1)))), text)
    text = re.sub(r"`([^`]+)`",
                  lambda m: stash("<code>%s</code>" % esc(m.group(1))), text)
    text = esc(text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![*\w])\*([^*\s][^*]*)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"&lt;(https?://localhost[^&\s]*)&gt;",
                  lambda m: stash("<code>%s</code>" % m.group(1)), text)
    text = re.sub(r"&lt;(https?://[^&\s]+)&gt;",
                  lambda m: stash(_link(m.group(1), m.group(1))), text)
    text = re.sub(r"&lt;([^@&\s]+@[^&\s]+)&gt;",
                  lambda m: stash('<a href="mailto:%s">%s</a>'
                                  % (m.group(1), m.group(1))), text)
    return re.sub(r"\x00(\d+)\x00", lambda m: parts[int(m.group(1))], text)


def _link(href, label):
    href = LINK_MAP.get(href, href)
    if href.startswith(REPO):
        return label
    if href.startswith(("http://", "https://")) and "fetchterminal.org" not in href:
        bare = re.sub(r"</?[^>]+>", "", label)
        return ('<a href="%s" target="_blank" rel="noopener noreferrer" '
                'aria-label="%s (opens in a new tab)">%s</a>'
                % (href, html.escape(bare, quote=True), label))
    return '<a href="%s">%s</a>' % (href, label)


def slug_of(text):
    """The same shape of anchor the markdown files already link to."""
    bare = re.sub(r"<[^>]+>", "", text).lower()
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", bare)).strip("-")


def convert(md, releases=False):
    """Markdown to the handful of HTML blocks the stylesheet knows about."""
    lines = md.split("\n")
    out = []
    i = 0
    open_list = None          # 'ul' or 'ol' while one is being built
    next_number = 1           # so an interrupted numbered list carries on
    in_release = False

    def close_list():
        nonlocal open_list
        if open_list:
            out.append("</%s>" % open_list)
            open_list = None

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            close_list()
            i += 1
            continue

        # Fenced code.
        if stripped.startswith("```"):
            close_list()
            i += 1
            body = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                body.append(lines[i])
                i += 1
            i += 1
            while body and not body[0].strip():
                body.pop(0)
            pad = min((len(x) - len(x.lstrip()) for x in body if x.strip()),
                      default=0)
            out.append("<pre><code>%s</code></pre>"
                       % esc("\n".join(x[pad:] for x in body)))
            continue

        # Headings. The h1 is dropped: the page template writes its own.
        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            close_list()
            next_number = 1
            level = len(m.group(1))
            if level == 1:
                i += 1
                continue
            if releases and level == 2:
                if in_release:
                    out.append("</div>")
                out.append('<div class="release">')
                in_release = True
            text = inline(m.group(2))
            out.append('<h%d id="%s">%s</h%d>'
                       % (level, slug_of(text), text, level))
            i += 1
            continue

        # Quoted notes.
        if stripped.startswith(">"):
            close_list()
            body = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                body.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append("<blockquote><p>%s</p></blockquote>"
                       % inline(" ".join(x.strip() for x in body if x.strip())))
            continue

        # Tables.
        if stripped.startswith("|"):
            close_list()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], rows[1:]
            if body and all(set(c) <= set("-: ") for c in body[0]):
                body = body[1:]
            out.append('<div class="table-wrap"><table><thead><tr>%s</tr></thead><tbody>'
                       % "".join("<th>%s</th>" % inline(c) for c in head))
            for row in body:
                out.append("<tr>%s</tr>"
                           % "".join("<td>%s</td>" % inline(c) for c in row))
            out.append("</tbody></table></div>")
            continue

        # List items, with their wrapped continuation lines.
        m = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)$", line)
        if m:
            indent, marker, text = m.group(1), m.group(2), m.group(3)
            kind = "ul" if marker in "-*" else "ol"
            i += 1
            while (i < len(lines) and lines[i].strip()
                   and not re.match(r"^\s*([-*]|\d+\.)\s+", lines[i])
                   and not lines[i].strip().startswith(("#", ">", "|", "```"))
                   and lines[i].startswith(" ")):
                text += " " + lines[i].strip()
                i += 1
            if open_list != kind:
                close_list()
                if kind == "ol":
                    out.append('<ol start="%d">' % next_number if next_number > 1
                               else "<ol>")
                else:
                    out.append("<ul>")
                open_list = kind
            if kind == "ol":
                next_number = int(marker.rstrip(".")) + 1
            cls = ' class="sub"' if indent else ""
            out.append("<li%s>%s</li>" % (cls, inline(text)))
            continue

        # An image on a line of its own: the page has its own branding.
        if re.fullmatch(r"!\[[^\]]*\]\([^)]*\)", stripped):
            i += 1
            continue

        # Everything else is a paragraph, joined to its wrapped lines.
        close_list()
        body = [stripped]
        i += 1
        while (i < len(lines) and lines[i].strip()
               and not re.match(r"^\s*([-*]|\d+\.)\s+", lines[i])
               and not lines[i].strip().startswith(("#", ">", "|", "```"))):
            body.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(body)))

    close_list()
    if in_release:
        out.append("</div>")
    return "\n".join(out)



# ---------------------------------------------------------------- the shell

START = '<div class="prose">'
MODEL = SITE / "privacy.html"
MODEL_TITLE = "Privacy: Fetch Terminal"
MODEL_DESC = ("What this website and the Fetch Terminal app collect about you, "
              "which is nothing, and where your own data lives.")
MODEL_URL = "https://fetchterminal.org/privacy"


def shell():
    text = MODEL.read_text()
    head, rest = text.split("<h1>Privacy</h1>", 1)
    tail = "        </div>\n      </div>\n    </section>" + rest.split(
        "        </div>\n      </div>\n    </section>", 1)[1]
    return head, tail


def page(slug, title, desc, heading, lead, body, head_tmpl, tail):
    head = (head_tmpl
            .replace(MODEL_TITLE, "%s: Fetch Terminal" % title)
            .replace(MODEL_DESC, desc)
            .replace(MODEL_URL, "https://fetchterminal.org/" + slug))
    for leftover in (MODEL_TITLE, "/privacy", MODEL_DESC):
        assert leftover not in head, "the shell still mentions %r" % leftover
    return (head + "<h1>%s</h1>\n        <p class=\"lede\">%s</p>\n"
            "        <div class=\"prose\">\n%s\n" % (heading, lead, body)) + tail


# ------------------------------------------------------------- GitHub strip

GH_PATH = ("M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z")

LINKS = [
    ("Repository", "", "Repository"),
    ("Documentation", "/blob/main/README.md", "Documentation"),
    ("Security", "/security/policy", "Security"),
    ("Licence", "/blob/main/LICENSE", "Licence"),
    ("Changelog", "/blob/main/CHANGELOG.md", "Changelog"),
    ("Issues", "/issues", "Issues"),
    ("Releases", "/releases", "Releases"),
]


def strip():
    nav = "\n".join(
        '        <a href="%s%s" target="_blank" rel="noopener noreferrer" '
        'aria-label="%s on GitHub (opens in a new tab)">%s</a>'
        % (REPO, path, label, label) for label, path, _ in LINKS)
    return f"""  <!-- github-strip -->
  <div class="oss-bar">
    <div class="wrap oss-bar-row">
      <div class="marks">
        <a href="{REPO}" target="_blank" rel="noopener noreferrer" aria-label="Fetch Terminal on GitHub (opens in a new tab)">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="{GH_PATH}"/></svg>
        </a>
        <a href="https://opensource.org" target="_blank" rel="noopener noreferrer" aria-label="Open Source Initiative (opens in a new tab)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="5" r="2.6"/><circle cx="5.2" cy="17" r="2.6"/><circle cx="18.8" cy="17" r="2.6"/>
            <path d="M10.7 7.3 6.5 14.7M13.3 7.3l4.2 7.4M7.8 17h8.4"/>
          </svg>
        </a>
      </div>
      <nav aria-label="Source code">
{nav}
      </nav>
    </div>
  </div>
  <!-- /github-strip -->
"""


def put_strip(path):
    text = path.read_text()
    text = re.sub(r"  <!-- github-strip -->.*?<!-- /github-strip -->\n", "", text,
                  flags=re.S)
    marker = '  <div class="sub-footer">'
    assert marker in text, "%s has no legal footer" % path.name
    path.write_text(text.replace(marker, strip() + marker, 1))


def stamp_css():
    css = SITE / "styles.css"
    digest = hashlib.sha256(css.read_bytes()).hexdigest()[:8]
    for page_file in sorted(SITE.glob("*.html")):
        text = page_file.read_text()
        new = re.sub(r'href="(?:/)?styles\.css(\?v=[0-9a-f]+)?"',
                     'href="/styles.css?v=%s"' % digest, text)
        if new != text:
            page_file.write_text(new)


def without_pictures(md):
    md = re.sub(r"<p align=\"center\">.*?</p>\s*", "", md, flags=re.S)
    return md


def main():
    head_tmpl, tail = shell()
    pages = [
        ("docs", "Documentation", "How to install and use Fetch Terminal, "
         "from first start to the password vault.", "Documentation",
         "Everything about running Fetch Terminal.",
         convert(without_pictures((ROOT / "README.md").read_text()))),
        ("changelog", "Changelog", "Every release of Fetch Terminal and what "
         "changed in it, newest first.", "Changelog",
         "Every release, newest first.",
         convert((ROOT / "CHANGELOG.md").read_text(), releases=True)),
        ("security", "Security", "How to report a security problem in Fetch "
         "Terminal, and how the app is built to be safe.", "Security",
         "How to report a security problem, and what the app does to protect you.",
         convert((ROOT / "SECURITY.md").read_text())),
        ("licence", "Licence", "Fetch Terminal is free software under version "
         "3 of the GNU General Public Licence, or any later version.", "Licence",
         "Fetch Terminal is free software under the GNU General Public Licence.",
         "<p>You may use it, read it, change it and pass it on, under the terms "
         "of version 3 of the GNU General Public Licence, or any later version. "
         "There is no warranty. The full text follows.</p>\n"
         '<pre class="licence-text"><code>'
         + esc((ROOT / "LICENSE").read_text().rstrip()) + "</code></pre>"),
        ("source", "Source", "Build Fetch Terminal from source.", "Source",
         "The code is public, and this is how to build it.",
         "<p>The source is on GitHub, linked from the foot of every page. "
         "You need Node.js and a toolchain for native modules, because the "
         "terminal component is compiled when you install.</p>\n"
         "<pre><code>sudo apt install -y build-essential python3\n"
         "npm install\nnpm start</code></pre>\n"
         "<p>To build the AppImage yourself:</p>\n"
         "<pre><code>npm run dist</code></pre>\n"
         "<p>It is written to your Downloads folder. The "
         '<a href="/docs">documentation</a> covers the rest, and the '
         '<a href="/changelog">changelog</a> records what changed in each '
         "release.</p>"),
    ]
    for slug, title, desc, heading, lead, body in pages:
        (SITE / (slug + ".html")).write_text(
            page(slug, title, desc, heading, lead, body, head_tmpl, tail))
    for page_file in sorted(SITE.glob("*.html")):
        put_strip(page_file)
    stamp_css()
    print("built", ", ".join(p[0] for p in pages))


if __name__ == "__main__":
    main()
