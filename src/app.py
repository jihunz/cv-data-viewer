from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
import json as pyjson
import time
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

APP_ROOT = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(APP_ROOT / "templates"))
STATIC_DIR = APP_ROOT / "static"

app = FastAPI(title="MegaFall Dataset Viewer")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
LABEL_EXT = ".txt"
DATASET_MODES = {"folder", "txt"}


@dataclass(frozen=True)
class TxtEntry:
    image_path: Path
    label_path: Path
    rel_path: str
    label_rel: str


_TXT_CACHE: Dict[Tuple[str, str], Tuple[float, List[TxtEntry], Dict[str, TxtEntry]]] = {}


def resolve_path_with_base(raw_path: str, base_dir: Optional[Path] = None) -> Path:
    cleaned = raw_path.strip()
    candidate = resolve_dataset_path(cleaned)
    if candidate.exists():
        return candidate
    if base_dir is not None:
        base_dir = base_dir.resolve()
        tentative = (base_dir / cleaned).expanduser().resolve()
        if tentative.exists():
            return tentative
    return candidate


def _join_file_if_exists(base: Path, rel: Path) -> Optional[Path]:
    if rel.is_absolute():
        return None
    base_resolved = base.resolve()
    candidate = (base_resolved / rel).resolve()
    try:
        candidate.relative_to(base_resolved)
    except ValueError:
        return None
    if candidate.is_file():
        return candidate
    return None


def find_label_for_image(image_path: Path, label_root: Path) -> Optional[Tuple[str, str, Path]]:
    label_root_resolved = label_root.resolve()
    seen_relatives: set[str] = set()
    for ancestor in image_path.parents:
        try:
            rel = image_path.relative_to(ancestor)
        except ValueError:
            continue
        rel_str = rel.as_posix()
        if rel_str in seen_relatives:
            continue
        seen_relatives.add(rel_str)
        label_rel = Path(rel_str).with_suffix(LABEL_EXT)
        candidate = _join_file_if_exists(label_root_resolved, label_rel)
        if candidate:
            return rel_str, label_rel.as_posix(), candidate

    filename_rel = Path(image_path.name)
    filename_rel_str = filename_rel.as_posix()
    if filename_rel_str not in seen_relatives:
        label_rel = filename_rel.with_suffix(LABEL_EXT)
        candidate = _join_file_if_exists(label_root_resolved, label_rel)
        if candidate:
            return filename_rel_str, label_rel.as_posix(), candidate
    return None


def load_train_entries(train_file_path: Path, label_dir_path: Path) -> List[TxtEntry]:
    train_file_path = train_file_path.resolve()
    label_dir_path = label_dir_path.resolve()
    cache_key = (str(train_file_path), str(label_dir_path))
    mtime = train_file_path.stat().st_mtime
    cached = _TXT_CACHE.get(cache_key)
    if cached and cached[0] == mtime:
        return cached[1]

    entries: List[TxtEntry] = []
    seen_rel_paths: set[str] = set()
    with train_file_path.open("r", encoding="utf-8") as fh:
        for raw_line in fh:
            path_str = raw_line.strip()
            if not path_str:
                continue
            image_path_candidate = resolve_path_with_base(path_str, train_file_path.parent)
            if not image_path_candidate.exists() or not image_path_candidate.is_file():
                continue
            if image_path_candidate.suffix.lower() not in IMAGE_EXTS:
                continue
            label_info = find_label_for_image(image_path_candidate, label_dir_path)
            if not label_info:
                continue
            rel_path, label_rel, label_abs = label_info
            if rel_path in seen_rel_paths:
                continue
            seen_rel_paths.add(rel_path)
            entries.append(
                TxtEntry(
                    image_path=image_path_candidate.resolve(),
                    label_path=label_abs,
                    rel_path=rel_path,
                    label_rel=label_rel,
                )
            )

    entries_by_rel = {entry.rel_path: entry for entry in entries}
    _TXT_CACHE[cache_key] = (mtime, entries, entries_by_rel)
    return entries


def get_train_entry_by_rel(train_file_path: Path, label_dir_path: Path, rel_path: str) -> Optional[TxtEntry]:
    train_file_path = train_file_path.resolve()
    label_dir_path = label_dir_path.resolve()
    cache_key = (str(train_file_path), str(label_dir_path))
    entries = load_train_entries(train_file_path, label_dir_path)
    cached = _TXT_CACHE.get(cache_key)
    if not cached:
        return None
    _, _, mapping = cached
    return mapping.get(rel_path)


def list_images(img_dir: Path, label_dir: Path) -> List[str]:
    images: List[str] = []
    depth_one = sorted(p for p in img_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
    depth_dirs = sorted(p for p in img_dir.iterdir() if p.is_dir())

    for img_path in depth_one:
        rel = img_path.relative_to(img_dir)
        if (label_dir / rel.with_suffix(LABEL_EXT)).is_file():
            images.append(str(rel))

    for subdir in depth_dirs:
        sub_images = [p for p in sorted(subdir.iterdir()) if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
        for img_path in sub_images:
            rel = img_path.relative_to(img_dir)
            if (label_dir / rel.with_suffix(LABEL_EXT)).is_file():
                images.append(str(rel))

    return images


def collect_images(img_dir: Path, label_dir: Path) -> List[str]:
    return list_images(img_dir, label_dir)


def safe_join(base: Path, rel: str) -> Path:
    candidate = (base / rel).resolve()
    if not candidate.is_file() or base.resolve() not in candidate.parents:
        raise HTTPException(status_code=404, detail="File not found")
    return candidate


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return TEMPLATES.TemplateResponse("index.html", {"request": request})


@app.get("/viewer", response_class=HTMLResponse)
def viewer(
    request: Request,
    mode: str = Query("folder"),
    img_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
):
    mode = (mode or "folder").lower()
    if mode not in DATASET_MODES:
        raise HTTPException(status_code=400, detail="Invalid dataset mode")

    prefill: Dict[str, Optional[str]] = {"mode": mode}
    if label_dir:
        prefill["label_dir"] = label_dir

    if not label_dir:
        return TEMPLATES.TemplateResponse(
            "index.html",
            {
                "request": request,
                "error": "Label directory is required.",
                "prefill": prefill,
            },
            status_code=400,
        )

    label_dir_path = resolve_dataset_path(label_dir)
    if not label_dir_path.exists() or not label_dir_path.is_dir():
        msg = f"Invalid label directory: {label_dir}"
        if label_dir != str(label_dir_path):
            msg += f" (Resolved: {label_dir_path})"
        print(f"[ERROR] {msg}")
        return TEMPLATES.TemplateResponse(
            "index.html",
            {
                "request": request,
                "error": msg,
                "prefill": prefill,
            },
            status_code=400,
        )

    if mode == "folder":
        prefill["img_dir"] = img_dir
        if not img_dir:
            return TEMPLATES.TemplateResponse(
                "index.html",
                {
                    "request": request,
                    "error": "Image directory is required for folder mode.",
                    "prefill": prefill,
                },
                status_code=400,
            )

        img_dir_path = resolve_dataset_path(img_dir)
        if not img_dir_path.exists() or not img_dir_path.is_dir():
            return TEMPLATES.TemplateResponse(
                "index.html",
                {
                    "request": request,
                    "error": f"Invalid image directory: {img_dir}",
                    "prefill": prefill,
                },
                status_code=400,
            )

        images = collect_images(img_dir_path, label_dir_path)
        if not images:
            return TEMPLATES.TemplateResponse(
                "index.html",
                {
                    "request": request,
                    "error": "No images with matching labels found.",
                    "prefill": prefill,
                },
                status_code=400,
            )

        data = {
            "mode": mode,
            "images": [{"rel_path": rel} for rel in images],
            "img_dir": str(img_dir_path.resolve()),
            "label_dir": str(label_dir_path.resolve()),
            "train_file": None,
        }
    else:  # txt mode
        prefill["train_file"] = train_file
        if not train_file:
            return TEMPLATES.TemplateResponse(
                "index.html",
                {
                    "request": request,
                    "error": "Train file path is required for txt mode.",
                    "prefill": prefill,
                },
                status_code=400,
            )

        train_file_path = resolve_dataset_path(train_file)
        if not train_file_path.exists() or not train_file_path.is_file():
            resolved_hint = str(train_file_path)
            return TEMPLATES.TemplateResponse(
                "index.html",
                {
                    "request": request,
                    "error": f"Invalid train file: {train_file} (resolved path: {resolved_hint}). If you run via Docker, ensure the directory is mounted into the container.",
                    "prefill": prefill,
                },
                status_code=400,
            )

        entries = load_train_entries(train_file_path, label_dir_path)
        if not entries:
            return TEMPLATES.TemplateResponse(
                "index.html",
                {
                    "request": request,
                    "error": "No valid image-label pairs found in train file.",
                    "prefill": prefill,
                },
                status_code=400,
            )

        data = {
            "mode": mode,
            "images": [{"rel_path": entry.rel_path, "label_rel": entry.label_rel} for entry in entries],
            "img_dir": None,
            "label_dir": str(label_dir_path.resolve()),
            "train_file": str(train_file_path.resolve()),
        }

    return TEMPLATES.TemplateResponse(
        "viewer.html",
        {"request": request, "data_json": json.dumps(data)},
    )


@app.get("/image")
def get_image(
    mode: str = Query("folder"),
    rel_path: str = Query(...),
    img_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
):
    mode = (mode or "folder").lower()
    if mode not in DATASET_MODES:
        raise HTTPException(status_code=400, detail="Invalid dataset mode")

    try:
        if mode == "folder":
            if not img_dir:
                raise HTTPException(status_code=400, detail="Image directory is required.")
            img_dir_path = resolve_dataset_path(img_dir)
            # Use resolve_path_with_base instead of safe_join for better resilience
            # But relative path logic in 'list_images' creates clean relatives.
            img_path = safe_join(img_dir_path, rel_path)
            return FileResponse(img_path)

        # txt mode
        if not train_file:
            raise HTTPException(status_code=400, detail="Train file is required.")
        
        train_file_path = resolve_dataset_path(train_file)
        label_dir_path = resolve_dataset_path(label_dir) if label_dir else None
        
        # First, try to look up in cache
        entry = get_train_entry_by_rel(train_file_path, label_dir_path, rel_path)
        if entry and entry.image_path.is_file():
            return FileResponse(entry.image_path)

        # Fallback: if cache miss (shouldn't happen if loaded correctly), try direct resolution
        # The rel_path might be the path string from train.txt
        # Try resolving it against train_file parent
        candidate = resolve_path_with_base(rel_path, train_file_path.parent)
        if candidate.exists() and candidate.is_file():
             return FileResponse(candidate)

        raise HTTPException(status_code=404, detail=f"Image not found: {rel_path}")

    except Exception as e:
        print(f"[ERROR] Failed to serve image {rel_path}: {e}")
        raise HTTPException(status_code=404, detail="Image not found")


@app.get("/api/labels")
def get_labels(
    mode: str = Query("folder"),
    rel_path: str = Query(...),
    img_dir: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
):
    mode = (mode or "folder").lower()
    if mode not in DATASET_MODES:
        raise HTTPException(status_code=400, detail="Invalid dataset mode")

    label_path = None
    label_rel_str = ""

    if mode == "folder":
        if not img_dir or not label_dir:
            raise HTTPException(status_code=400, detail="Image and label directories are required.")
        img_dir_path = resolve_dataset_path(img_dir)
        label_dir_path = resolve_dataset_path(label_dir)
        
        # Verify image existence
        try:
            safe_join(img_dir_path, rel_path) 
        except:
            pass # It's okay if image check fails here, we just want labels

        label_rel_path = Path(rel_path).with_suffix(LABEL_EXT)
        label_path = (label_dir_path / label_rel_path).resolve()
        label_rel_str = str(label_rel_path)
    else:
        # txt mode
        if not train_file or not label_dir:
            raise HTTPException(status_code=400, detail="Train file and label directory are required.")
        train_file_path = resolve_dataset_path(train_file)
        label_dir_path = resolve_dataset_path(label_dir)
        
        entry = get_train_entry_by_rel(train_file_path, label_dir_path, rel_path)
        if entry:
            label_path = entry.label_path
            label_rel_str = entry.label_rel
        else:
            # Fallback logic if cache miss
             # Try to construct label path manually
            # This is tricky for txt mode as relative path is arbitrary.
            # But usually relative path in entry is the line from txt file.
            # Let's try to resolve it.
            pass

    if not label_path or not label_path.exists() or not label_path.is_file():
         # Return empty labels instead of 404 to prevent frontend errors on grid
         return JSONResponse({
            "image": rel_path,
            "label": label_rel_str,
            "labels": [],
        })

    labels = []
    try:
        with label_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                parts = line.split()
                try:
                    cls = int(float(parts[0]))
                    bbox = [float(val) for val in parts[1:5]]
                    labels.append({"class": cls, "bbox": bbox})
                except (ValueError, IndexError):
                    continue
    except Exception as e:
        print(f"[ERROR] Failed to read label {label_path}: {e}")

    return JSONResponse(
        {
            "image": rel_path,
            "label": label_rel_str,
            "labels": labels,
        }
    )


@app.get("/api/progress")
def scan_progress(
    mode: str = Query("folder"),
    img_dir: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
):
    mode = (mode or "folder").lower()

    def event_stream():
        start = time.time()
        if mode not in DATASET_MODES:
            yield f"data: {pyjson.dumps({'status': 'error', 'message': 'Invalid dataset mode'})}\n\n"
            return
        if not label_dir:
            yield f"data: {pyjson.dumps({'status': 'error', 'message': 'Label directory is required'})}\n\n"
            return

        label_dir_path = resolve_dataset_path(label_dir)
        if not label_dir_path.exists() or not label_dir_path.is_dir():
            yield f"data: {pyjson.dumps({'status': 'error', 'message': f'Invalid label directory (mapped: {label_dir_path})'})}\n\n"
            return

        if mode == "folder":
            if not img_dir:
                yield f"data: {pyjson.dumps({'status': 'error', 'message': 'Image directory is required'})}\n\n"
                return
            img_dir_path = resolve_dataset_path(img_dir)
            if not img_dir_path.exists() or not img_dir_path.is_dir():
                yield f"data: {pyjson.dumps({'status': 'error', 'message': 'Invalid image directory'})}\n\n"
                return
            rel_images = list_images(img_dir_path, label_dir_path)
        else:
            if not train_file:
                yield f"data: {pyjson.dumps({'status': 'error', 'message': 'Train file is required'})}\n\n"
                return
            train_file_path = resolve_dataset_path(train_file)
            if not train_file_path.exists() or not train_file_path.is_file():
                msg = (
                    f"Invalid train file: {train_file} (resolved path: {train_file_path}). "
                    "If you run via Docker, verify that the file's directory is mounted."
                )
                yield f"data: {pyjson.dumps({'status': 'error', 'message': msg})}\n\n"
                return
            entries = load_train_entries(train_file_path, label_dir_path)
            rel_images = [entry.rel_path for entry in entries]

        total = len(rel_images)
        if not total:
            yield f"data: {pyjson.dumps({'status': 'error', 'message': 'No images with matching labels found.'})}\n\n"
            return

        step = max(1, total // 200)
        for idx, _ in enumerate(rel_images, 1):
            if idx % step == 0 or idx == total:
                progress = idx / total
                elapsed = time.time() - start
                remaining = (elapsed / progress) - elapsed if progress > 0 else None
                payload = {
                    'status': 'progress',
                    'progress': round(progress * 100, 2),
                    'elapsed': round(elapsed, 2),
                    'eta': round(remaining, 2) if remaining is not None else None,
                }
                yield f"data: {pyjson.dumps(payload)}\n\n"

        params = [("mode", mode), ("label_dir", label_dir)]
        if mode == "folder":
            params.append(("img_dir", img_dir))
        else:
            params.append(("train_file", train_file))
        query = "&".join(f"{key}={quote(value, safe='')}" for key, value in params if value)
        viewer_url = f"/viewer?{query}"
        final_payload = {
            'status': 'done',
            'progress': 100.0,
            'elapsed': round(time.time() - start, 2),
            'viewer_url': viewer_url,
        }
        yield f"data: {pyjson.dumps(final_payload)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
HOST_DATA_ROOT = Path("/Users/jihunjang/Downloads/ust/dataset/train")
CONTAINER_DATA_ROOT = Path("/datasets")


def resolve_dataset_path(raw_path: str) -> Path:
    path_str = raw_path.strip()
    # 1. Try local existence (Local Mode)
    candidate = Path(path_str).expanduser()
    if candidate.exists():
        return candidate.resolve()

    # 2. Try Docker Mapping
    # We treat input paths as pure strings because we might be inside the container
    # and cannot resolve host paths.
    host_root_str = str(HOST_DATA_ROOT).rstrip("/")
    input_path_str = str(candidate)

    if input_path_str.startswith(host_root_str):
        relative_part = input_path_str[len(host_root_str):].lstrip("/")
        mapped = (CONTAINER_DATA_ROOT / relative_part).resolve()
        if mapped.exists():
            print(f"[DEBUG] Successfully mapped: {raw_path} -> {mapped}")
            return mapped
        else:
            print(f"[DEBUG] Mapped path not found: {mapped} (Original: {raw_path})")
    else:
        print(f"[DEBUG] Path outside host root: {input_path_str} (Root: {host_root_str})")

    return candidate
