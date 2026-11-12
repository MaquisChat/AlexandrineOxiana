"""The optional tools offered on first use (R126, ADR 0009, ADR 0014): what each is for, and where
each part is downloaded from, pinned by address, size and SHA-256 per platform.

Platforms: `macos-arm64`, `macos-x64`, `linux-x64` (CI). `any` is a download that is the same on
every platform (data, pure Python). A platform with no pin carries an `Unavailable` reason instead:
nothing is ever downloaded from an address that is not written here (yt-dlp excepted, which follows
ADR 0009: the latest release, checked against that release's published SHA2-256SUMS).

Every pin below was checked on 2026-11-11 by downloading the file and hashing it (the speech
models' `model.bin` by the SHA-256 Hugging Face publishes for it, which is the hash of the file).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

PLATFORMS = ("macos-arm64", "macos-x64", "linux-x64")


@dataclass(frozen=True)
class Download:
    """One file fetched with a plain GET. Exactly one of `save_as`, `extract` or `extract_all_under`."""

    url: str
    sha256: str
    size: int
    # A plain file kept as is, at this path relative to the component's folder.
    save_as: str | None = None
    # A zip archive: only these members are unpacked, each to the relative path given.
    extract: tuple[tuple[str, str], ...] = ()
    # A zip archive unpacked whole into this relative folder (a pure-Python wheel).
    extract_all_under: str | None = None
    # Bytes the archive holds once unpacked (the limit unpacking is held to).
    unpacked: int = 0


@dataclass(frozen=True)
class Unavailable:
    reason: str


@dataclass(frozen=True)
class Component:
    """One installable part. Installed atomically as one folder `<root>/<folder>`."""

    id: str
    name: str
    version: str
    licence: str
    # "pinned": the downloads below; "ytdlp": the latest release (ADR 0009); "model": a speech model.
    kind: str
    # "tools" (AO_TOOLS_DIR) or "models" (AO_MODELS_DIR).
    root: str
    folder: str
    downloads: Mapping[str, tuple[Download, ...] | Unavailable] = field(default_factory=dict)
    # Relative paths made executable (mode 0755) after unpacking.
    executables: tuple[str, ...] = ()
    # Hosts a download may be redirected to: exact names, or ".suffix" for any host under it.
    hosts: tuple[str, ...] = ()
    # Small files written into the folder after the downloads (relative path -> text).
    write: tuple[tuple[str, str], ...] = ()
    # Download size shown when it is not pinned (yt-dlp: the latest release's size is not known ahead).
    approx_size: int = 0
    # Hosts contacted by a program's own updater rather than by the worker's downloads (named in the
    # catalogue's `hosts`, R158; not enforced by the worker, which does not make those requests).
    update_hosts: tuple[str, ...] = ()


@dataclass(frozen=True)
class Tool:
    """One choice offered to the researcher; one or more components."""

    id: str
    group: str
    name: str
    purpose: str
    without: str
    components: tuple[str, ...]
    notice: str | None = None


HF_HOSTS = ("huggingface.co", ".hf.co")
GITHUB_HOSTS = ("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")

# ---------- speech models (Hugging Face Systran/faster-whisper-*, MIT) ----------

_HF = "https://huggingface.co/Systran/faster-whisper-{name}/resolve/{rev}/{file}"
_TOKENIZER = ("tokenizer.json", "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab", 2203239)
_VOCABULARY = ("vocabulary.txt", "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913", 459861)

# name -> (revision, [(file, sha256, size), ...])
MODEL_PINS: dict[str, tuple[str, tuple[tuple[str, str, int], ...]]] = {
    "tiny": ("d90ca5fe260221311c53c58e660288d3deb8d356", (
        ("config.json", "a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8", 2249),
        ("model.bin", "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1", 75538270),
        _TOKENIZER, _VOCABULARY,
    )),
    "small": ("536b0662742c02347bc0e980a01041f333bce120", (
        ("config.json", "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828", 2370),
        ("model.bin", "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671", 483546902),
        _TOKENIZER, _VOCABULARY,
    )),
    "medium": ("08e178d48790749d25932bbc082711ddcfdfbc4f", (
        ("config.json", "3622a2ddc41ec0e0fd4e68c13c6830f03b90c38d89aaad184de02c8c642cf807", 2257),
        ("model.bin", "9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae", 1527906378),
        _TOKENIZER, _VOCABULARY,
    )),
    "large-v3": ("edaa852ec7e145841d8ffdb056a99866b5f0a478", (
        ("config.json", "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9", 2394),
        ("model.bin", "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1", 3087284237),
        ("preprocessor_config.json", "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711", 340),
        ("tokenizer.json", "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca", 2480617),
        ("vocabulary.json", "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1", 1068114),
    )),
}


def model_folder(name: str) -> str:
    """The Hugging Face cache folder faster-whisper looks the model up in (`models--<owner>--<repo>`)."""
    return f"models--Systran--faster-whisper-{name}"


def _model_component(name: str) -> Component:
    rev, files = MODEL_PINS[name]
    downloads = tuple(
        Download(url=_HF.format(name=name, rev=rev, file=f), sha256=sha, size=size, save_as=f"snapshots/{rev}/{f}")
        for f, sha, size in files
    )
    return Component(
        id=f"model-{name}", name=f"Speech model ({name})", version=rev[:7], licence="MIT", kind="model",
        root="models", folder=model_folder(name), downloads={"any": downloads}, hosts=HF_HOSTS,
        # Hugging Face's cache layout: refs/main names the snapshot that a local-only look-up returns.
        write=(("refs/main", rev),),
    )


# ---------- the JavaScript runtime yt-dlp needs for YouTube (deno, MIT) ----------

_DENO = "https://dl.deno.land/release/v2.9.8/deno-{target}.zip"
DENO = Component(
    id="deno", name="JavaScript runtime (deno)", version="2.9.8", licence="MIT", kind="pinned",
    root="tools", folder="deno", executables=("deno",), hosts=("dl.deno.land",),
    downloads={
        "macos-arm64": (Download(_DENO.format(target="aarch64-apple-darwin"),
                                 "5882caa6c9b7ab7adb06f23ec1894ac5bec0b1a5df1195157f75829a0d3cb651", 38771689,
                                 extract=(("deno", "deno"),), unpacked=120_000_000),),
        "macos-x64": (Download(_DENO.format(target="x86_64-apple-darwin"),
                               "05968936d544988b3e0116c9a07204e246956f78476ae5000652f2a9e2e4d075", 42797069,
                               extract=(("deno", "deno"),), unpacked=120_000_000),),
        "linux-x64": (Download(_DENO.format(target="x86_64-unknown-linux-gnu"),
                               "a39762429792913fe762ef0b59c9cba41dbd38195984da99221a193b13d97b40", 41963087,
                               extract=(("deno", "deno"),), unpacked=120_000_000),),
    },
)

YTDLP = Component(
    id="yt-dlp", name="Video downloader (yt-dlp)", version="latest", licence="Unlicense; the standalone build is GPL-3.0-or-later",
    kind="ytdlp", root="tools", folder="yt-dlp", hosts=GITHUB_HOSTS, approx_size=38_000_000,
    # `yt-dlp --update-to stable` asks GitHub's API for the release, then fetches from the hosts above.
    update_hosts=("api.github.com",),
)

# ---------- ffmpeg + ffprobe (Martin Riedl's 9.0.2 release builds, GPL; ADR 0014 until our own build exists) ----------

_RIEDL = "https://ffmpeg.martin-riedl.de/download/{path}/{file}.zip"


def _riedl(path: str, ffmpeg: tuple[str, int], ffprobe: tuple[str, int]) -> tuple[Download, ...]:
    return (
        Download(_RIEDL.format(path=path, file="ffmpeg"), ffmpeg[0], ffmpeg[1], extract=(("ffmpeg", "ffmpeg"),), unpacked=150_000_000),
        Download(_RIEDL.format(path=path, file="ffprobe"), ffprobe[0], ffprobe[1], extract=(("ffprobe", "ffprobe"),), unpacked=150_000_000),
    )


FFMPEG = Component(
    id="ffmpeg", name="ffmpeg and ffprobe", version="9.0.2", licence="GPL-3.0-or-later", kind="pinned",
    root="tools", folder="ffmpeg", executables=("ffmpeg", "ffprobe"), hosts=("ffmpeg.martin-riedl.de",),
    downloads={
        "macos-arm64": _riedl("macos/arm64/1789931890_9.0.2",
                              ("c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", 28395699),
                              ("fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6", 28317701)),
        "macos-x64": _riedl("macos/amd64/1789931006_9.0.2",
                            ("7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4", 33816391),
                            ("2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd", 33719233)),
        "linux-x64": _riedl("linux/amd64/1789931100_9.0.2",
                            ("fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f", 33326445),
                            ("3f428c49070be3d24ec338602b76d412e401ffcb8a5641ef0e729181a232fc32", 33223234)),
    },
)

# ---------- OCR: tesseract and its English language data ----------

_NO_TESSERACT = ("No tesseract build is published for this platform yet: tesseract publishes no Mac or "
                 "Linux programs, and the app's own signed build (ADR 0014) does not exist yet. A "
                 "tesseract already installed on this computer is used.")
TESSERACT = Component(
    id="tesseract", name="Text recognition (tesseract)", version="5.5", licence="Apache-2.0", kind="pinned",
    root="tools", folder="tesseract", executables=("bin/tesseract",),
    downloads={p: Unavailable(_NO_TESSERACT) for p in PLATFORMS},
)
TESSDATA = Component(
    id="tessdata", name="Text recognition language data (English)", version="tessdata_fast 4.1.0", licence="Apache-2.0",
    kind="pinned", root="tools", folder="tessdata", hosts=("raw.githubusercontent.com",),
    downloads={"any": (Download("https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata",
                                "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2", 4113088,
                                save_as="eng.traineddata"),)},
)

# ---------- gallery-dl (GPL-2.0-only): not inside the worker any more; the PyPI wheel, run as its own program ----------

GALLERYDL = Component(
    id="gallery-dl", name="Image downloader (gallery-dl)", version="1.32.19", licence="GPL-2.0-only", kind="pinned",
    root="tools", folder="gallery-dl", hosts=("files.pythonhosted.org",),
    downloads={"any": (Download(
        "https://files.pythonhosted.org/packages/5d/c3/87c38fa0d392455a14b3f32b8a3acf0887ced4689a7b5fc6e0d9f761213f/gallery_dl-1.32.19-py3-none-any.whl",
        "f6b1eb5e9a7409a988b754335d99dbb1873e130d133ed5d164d32e5e645d1c50", 946594,
        extract_all_under="lib", unpacked=8_000_000),)},
)

COMPONENTS: dict[str, Component] = {
    c.id: c for c in (
        *(_model_component(n) for n in ("tiny", "small", "medium", "large-v3")),
        YTDLP, DENO, FFMPEG, TESSERACT, TESSDATA, GALLERYDL,
    )
}

_MODEL_PURPOSE = {
    "tiny": "Transcribes recordings quickly with the smallest speech model (least accurate; good for trying things out).",
    "small": "Transcribes recordings with the small speech model (a good balance of speed and accuracy).",
    "medium": "Transcribes recordings with the medium speech model (more accurate, slower).",
    "large-v3": "Transcribes recordings with the largest speech model (most accurate, slowest; needs a fast computer).",
}

TOOLS: dict[str, Tool] = {
    t.id: t for t in (
        *(Tool(id=f"speech-{n}", group="speech", name=f"Speech model: {n}", purpose=_MODEL_PURPOSE[n],
               without=f"Transcription with the {n} model is not available.", components=(f"model-{n}",))
          for n in ("tiny", "small", "medium", "large-v3")),
        Tool(id="video-downloader", group="capture", name="Video downloader",
             purpose="Saves videos, subtitles and the platform's details from YouTube, TikTok, Instagram and other sites. "
                     "Two parts: yt-dlp and the JavaScript runtime it needs for YouTube.",
             without="Links to videos cannot be captured; pages can still be saved from the browser extension.",
             components=("yt-dlp", "deno"),
             notice="yt-dlp is always the latest release (sites change often); it is checked against the checksums "
                    "its authors publish. Downloading from platforms may conflict with their terms of service."),
        Tool(id="image-downloader", group="capture", name="Image downloader",
             purpose="Saves photos and carousels from Instagram and TikTok posts (gallery-dl).",
             without="Instagram photo posts and TikTok photo carousels cannot be captured.",
             components=("gallery-dl",),
             notice="gallery-dl is free software under the GNU GPL version 2; it runs as its own program."),
        Tool(id="ffmpeg", group="media", name="Video tools (ffmpeg)",
             purpose="Makes viewing copies of videos, and copies that leave out or coarsen a recorded location.",
             without="Videos get no viewing copies. Media that carries a location stays \"proxy pending\" and is "
                     "left out of exports until ffmpeg is installed.",
             components=("ffmpeg",),
             notice="This ffmpeg is free software under the GNU GPL; its source is published by its builder."),
        Tool(id="ocr", group="documents", name="Text recognition (OCR)",
             purpose="Makes the text of scanned PDFs searchable (tesseract with English language data).",
             without="Scanned PDFs are kept, but their text cannot be searched.",
             components=("tesseract", "tessdata")),
    )
}

# The speech models' tool ids, by faster-whisper model name.
SPEECH_TOOL = {n: f"speech-{n}" for n in MODEL_PINS}
