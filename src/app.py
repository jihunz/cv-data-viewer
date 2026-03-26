from __future__ import annotations

import io
import json
import os
import queue
import re
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from urllib.parse import quote

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image

# YOLO Model (Lazy Loading)
_YOLO_MODEL: Any = None
_YOLO_MODEL_PATH: Optional[Path] = None

# --- Configuration ---
APP_ROOT = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(APP_ROOT / "templates"))
STATIC_DIR = APP_ROOT / "static"
MODEL_DIR = APP_ROOT / "model"

# Check Env
if not (APP_ROOT / "templates").exists():
    print(f"[WARNING] Templates directory not found at {APP_ROOT / 'templates'}")

# --- YOLO Model Helper ---
def get_yolo_model(model_name: str = "yolo12x"):
    """Lazy load YOLO model"""
    global _YOLO_MODEL, _YOLO_MODEL_PATH
    
    model_path = MODEL_DIR / f"{model_name}.pt"
    
    # Return cached model if same path
    if _YOLO_MODEL is not None and _YOLO_MODEL_PATH == model_path:
        return _YOLO_MODEL
    
    if not model_path.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_path}")
    
    try:
        from ultralytics import YOLO
        print(f"[INFO] Loading YOLO model from {model_path}...")
        _YOLO_MODEL = YOLO(str(model_path))
        _YOLO_MODEL_PATH = model_path
        print(f"[INFO] YOLO model loaded successfully")
        return _YOLO_MODEL
    except Exception as e:
        print(f"[ERROR] Failed to load YOLO model: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")

# --- Data Roots ---
HOST_HOME = os.environ.get("HOST_HOME", "")
CONTAINER_MOUNT = "/host"

PATH_MAPPINGS: List[Tuple[str, str]] = []
if HOST_HOME:
    PATH_MAPPINGS.append((HOST_HOME, CONTAINER_MOUNT))

# --- App Init ---
app = FastAPI(title="CV Data Viewer")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.on_event("startup")
async def startup_event():
    print(f"[INFO] Server Started.")
    print(f"[INFO] Root: {APP_ROOT}")
    print(f"[INFO] Routes: {[r.path for r in app.routes]}")

# --- Constants ---
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
LABEL_EXT = ".txt"
DATASET_MODES = {"folder", "txt", "annotate", "compare"}

_HASH_RE = re.compile(r'_[0-9a-fA-F]{8}_')

def _normalize_stem(stem: str) -> str:
    return _HASH_RE.sub('_', stem)

def _find_fuzzy_label(label_dir: Path, img_rel: Path) -> Optional[Path]:
    exact = label_dir / img_rel.with_suffix(LABEL_EXT)
    if exact.is_file():
        return exact
    parent = label_dir / img_rel.parent
    if not parent.is_dir():
        parent = label_dir
    target_key = _normalize_stem(img_rel.stem)
    for lbl in parent.iterdir():
        if lbl.suffix == LABEL_EXT and _normalize_stem(lbl.stem) == target_key:
            return lbl
    return None

# --- Cache & Helper Classes ---
@dataclass(frozen=True)
class TxtEntry:
    image_path: Path
    label_path: Path
    rel_path: str
    label_rel: str

_TXT_CACHE: Dict[Tuple[str, str], Tuple[float, List[TxtEntry], Dict[str, TxtEntry]]] = {}

# --- Helper Functions ---
def resolve_dataset_path(raw_path: str) -> Path:
    path_str = raw_path.strip()
    candidate = Path(path_str)

    if candidate.exists():
        return candidate.resolve()

    try:
        input_str = str(Path(path_str).expanduser().resolve())
        for host_prefix, container_prefix in PATH_MAPPINGS:
            if input_str.startswith(host_prefix):
                rel_part = input_str[len(host_prefix):].lstrip("/")
                mapped = Path(container_prefix) / rel_part
                print(f"[DEBUG] Mapping: {input_str} -> {mapped}")
                if mapped.exists():
                    return mapped.resolve()
                else:
                    print(f"[WARN] Mapped path does not exist: {mapped}")
    except Exception as e:
        print(f"[ERROR] Path resolution failed: {e}")

    return candidate

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


def map_image_path_to_label_path(image_path: Path) -> Optional[Path]:
    """
    Auto-map image path to label path by replacing '/images/' with '/labels/'
    and changing extension to .txt
    Example: /path/to/images/train/img.jpg -> /path/to/labels/train/img.txt
    """
    path_str = str(image_path)
    if "/images/" in path_str:
        label_str = path_str.replace("/images/", "/labels/")
        label_path = Path(label_str).with_suffix(LABEL_EXT)
        return label_path
    return None

def load_train_entries(train_file_path: Path, label_dir_path: Optional[Path] = None) -> List[TxtEntry]:
    """
    Load train entries from a train.txt file.
    If label_dir_path is None, uses auto-mapping (/images/ -> /labels/).
    """
    train_file_path = train_file_path.resolve()
    label_dir_str = str(label_dir_path.resolve()) if label_dir_path else "auto"
    cache_key = (str(train_file_path), label_dir_str)
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
            
            # Try to find label
            if label_dir_path:
                # Use explicit label directory
                label_info = find_label_for_image(image_path_candidate, label_dir_path)
                if not label_info:
                    continue
                rel_path, label_rel, label_abs = label_info
            else:
                # Auto-mapping: /images/ -> /labels/
                label_path = map_image_path_to_label_path(image_path_candidate)
                if not label_path or not label_path.exists():
                    continue
                # Use image filename as rel_path for consistency
                rel_path = image_path_candidate.name
                label_rel = label_path.name
                label_abs = label_path
            
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

def get_train_entry_by_rel(train_file_path: Path, label_dir_path: Optional[Path], rel_path: str) -> Optional[TxtEntry]:
    train_file_path = train_file_path.resolve()
    label_dir_str = str(label_dir_path.resolve()) if label_dir_path else "auto"
    cache_key = (str(train_file_path), label_dir_str)
    entries = load_train_entries(train_file_path, label_dir_path)
    cached = _TXT_CACHE.get(cache_key)
    if not cached:
        return None
    _, _, mapping = cached
    return mapping.get(rel_path)

def list_images(img_dir: Path, label_dir: Optional[Path] = None) -> List[str]:
    if not img_dir.exists():
        return []

    all_imgs: List[Path] = []
    depth_one = sorted(p for p in img_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
    all_imgs.extend(depth_one)
    for subdir in sorted(p for p in img_dir.iterdir() if p.is_dir()):
        all_imgs.extend(sorted(p for p in subdir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS))

    if not label_dir or not label_dir.exists():
        return [str(p.relative_to(img_dir)) for p in all_imgs]

    # 1단계: 정확 매칭
    images: List[str] = []
    for img_path in all_imgs:
        rel = img_path.relative_to(img_dir)
        if (label_dir / rel.with_suffix(LABEL_EXT)).is_file():
            images.append(str(rel))
    if images:
        return images

    # 2단계: 퍼지 매칭 (해시 제거 후 비교)
    for img_path in all_imgs:
        rel = img_path.relative_to(img_dir)
        if _find_fuzzy_label(label_dir, rel):
            images.append(str(rel))
    if images:
        return images

    # 3단계: 라벨 매칭 실패 시 전체 이미지 반환 (라벨 없이 보기)
    return [str(p.relative_to(img_dir)) for p in all_imgs]

def collect_images(img_dir: Path, label_dir: Path) -> List[str]:
    return list_images(img_dir, label_dir)

def resolve_dataset_dir(dataset_dir: str) -> Tuple[Path, Optional[Path]]:
    """데이터셋 디렉터리에서 img_dir, label_dir 자동 감지.
    images/ 하위 폴더가 있으면 사용, 없으면 루트를 img_dir로.
    labels/ 하위 폴더가 있으면 사용, 없으면 None.
    """
    base = resolve_dataset_path(dataset_dir)
    img_dir = base / "images"
    label_dir = base / "labels"
    if not img_dir.is_dir():
        img_dir = base
    label_dir = label_dir if label_dir.is_dir() else None
    return img_dir, label_dir

def safe_join(base: Path, rel: str) -> Path:
    candidate = (base / rel).resolve()
    # Allow resolving inside container structure
    if not candidate.is_file():
         raise HTTPException(status_code=404, detail=f"File not found: {rel}")
    return candidate

# --- Routes ---

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return TEMPLATES.TemplateResponse("index.html", {"request": request})

@app.get("/annotate", response_class=HTMLResponse)
def annotate_page(
    request: Request,
    dataset_dir: Optional[str] = Query(None),
    img_dir: Optional[str] = Query(None, description="Path to image directory"),
    label_dir: Optional[str] = Query(None, description="Path to label directory (optional, for loading existing labels)"),
):
    if dataset_dir and not img_dir:
        _img, _lbl = resolve_dataset_dir(dataset_dir)
        img_dir = str(_img)
        if _lbl and not label_dir:
            label_dir = str(_lbl)
    if not img_dir:
        raise HTTPException(status_code=400, detail="img_dir or dataset_dir required")
    print(f"[DEBUG] Annotate request for: {img_dir}, label_dir: {label_dir}")
    img_dir_path = resolve_dataset_path(img_dir)
    print(f"[DEBUG] Resolved path: {img_dir_path}, Is Dir: {img_dir_path.is_dir()}")
    
    if not img_dir_path.exists() or not img_dir_path.is_dir():
        raise HTTPException(status_code=404, detail=f"Image directory not found: {img_dir} (mapped: {img_dir_path})")

    # Resolve label directory if provided
    label_dir_path = None
    if label_dir:
        label_dir_path = resolve_dataset_path(label_dir)
        if not label_dir_path.exists() or not label_dir_path.is_dir():
            raise HTTPException(status_code=404, detail=f"Label directory not found: {label_dir} (mapped: {label_dir_path})")
        print(f"[DEBUG] Label dir resolved: {label_dir_path}")

    images = []
    for p in sorted(img_dir_path.rglob("*")):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
            rel = p.relative_to(img_dir_path).as_posix()
            images.append(rel)
    
    if not images:
        raise HTTPException(status_code=404, detail="No images found in directory")

    data = {
        "img_dir": str(img_dir_path.resolve()),
        "label_dir": str(label_dir_path.resolve()) if label_dir_path else None,
        "images": images
    }

    return TEMPLATES.TemplateResponse(
        "annotate.html",
        {"request": request, "data_json": json.dumps(data)},
    )

class _QueueFile:
    """Non-seekable file-like object that pushes written data into a queue."""
    def __init__(self, q: queue.Queue):
        self._q = q
        self._pos = 0

    def write(self, data: bytes) -> int:
        self._q.put(data)
        self._pos += len(data)
        return len(data)

    def tell(self) -> int:
        return self._pos

    def seekable(self) -> bool:
        return False

    def flush(self) -> None:
        pass


@app.post("/api/export")
def export_dataset(request: Request, payload: dict):
    img_dir = resolve_dataset_path(payload["img_dir"])
    target_w, target_h = payload["target_size"]
    annotations = payload["annotations"]

    q: queue.Queue[bytes | None] = queue.Queue(maxsize=32)

    def _produce():
        try:
            qf = _QueueFile(q)
            with zipfile.ZipFile(qf, "w", zipfile.ZIP_STORED) as zf:
                for rel_path, boxes in annotations.items():
                    try:
                        src_path = img_dir / rel_path
                        if not src_path.exists():
                            print(f"[WARN] Image not found: {src_path}")
                            continue

                        with Image.open(src_path) as img:
                            if img.mode == 'RGBA':
                                img = img.convert('RGB')
                            resized = img.resize((target_w, target_h))
                            img_bytes = io.BytesIO()
                            fmt = img.format if img.format else "JPEG"
                            resized.save(img_bytes, format=fmt, quality=95)

                            out_name = Path(rel_path).with_suffix(".jpg").as_posix()
                            zf.writestr(f"images/{out_name}", img_bytes.getvalue())
                    except Exception as e:
                        print(f"[EXPORT ERROR] {rel_path}: {e}")
                        continue

                    label_content = []
                    for box in boxes:
                        line = f"{int(box[0])} {box[1]:.6f} {box[2]:.6f} {box[3]:.6f} {box[4]:.6f}"
                        label_content.append(line)

                    label_rel = Path(rel_path).with_suffix(".txt").as_posix()
                    zf.writestr(f"labels/{label_rel}", "\n".join(label_content))
        except Exception as e:
            print(f"[EXPORT FATAL] {e}")
        finally:
            q.put(None)  # sentinel

    def _stream():
        t = threading.Thread(target=_produce, daemon=True)
        t.start()
        while True:
            chunk = q.get()
            if chunk is None:
                break
            yield chunk
        t.join()

    filename = f"dataset_{int(time.time())}.zip"
    return StreamingResponse(
        _stream(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )

@app.get("/viewer", response_class=HTMLResponse)
def viewer(
    request: Request,
    mode: str = Query("folder"),
    dataset_dir: Optional[str] = Query(None),
    img_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
    pred_label_dir: Optional[str] = Query(None),
    pred_label_dir_a: Optional[str] = Query(None),
    pred_label_dir_b: Optional[str] = Query(None),
    gt_label_dir: Optional[str] = Query(None),
):
    mode = (mode or "folder").lower()
    if mode not in DATASET_MODES:
        raise HTTPException(status_code=400, detail="Invalid dataset mode")

    # dataset_dir 자동 감지: images/, labels/ 하위 폴더 유무 판단
    if dataset_dir and not img_dir:
        _img, _lbl = resolve_dataset_dir(dataset_dir)
        img_dir = str(_img)
        if _lbl and not label_dir:
            label_dir = str(_lbl)

    prefill: Dict[str, Optional[str]] = {"mode": mode}
    if label_dir:
        prefill["label_dir"] = label_dir

    label_dir_path: Optional[Path] = None
    if label_dir:
        label_dir_path = resolve_dataset_path(label_dir)
        if not label_dir_path.exists():
            label_dir_path = None

    if mode == "compare":
        eff_pred_a = pred_label_dir_a or pred_label_dir
        eff_pred_b = pred_label_dir_b

        prefill["img_dir"] = img_dir
        prefill["gt_label_dir"] = gt_label_dir
        if not img_dir:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "Image directory required for compare mode", "prefill": prefill}, status_code=400)
        if not eff_pred_a:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "Prediction label directory A required", "prefill": prefill}, status_code=400)
        if not gt_label_dir:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "GT label directory required for compare mode", "prefill": prefill}, status_code=400)

        img_dir_path = resolve_dataset_path(img_dir)
        pred_a_path = resolve_dataset_path(eff_pred_a)
        gt_dir_path = resolve_dataset_path(gt_label_dir)
        pred_b_path = resolve_dataset_path(eff_pred_b) if eff_pred_b else None

        check_dirs = [("Image", img_dir_path), ("Prediction A", pred_a_path), ("GT", gt_dir_path)]
        if pred_b_path:
            check_dirs.append(("Prediction B", pred_b_path))
        for tag, p in check_dirs:
            if not p.exists() or not p.is_dir():
                return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": f"{tag} directory not found: {p}", "prefill": prefill}, status_code=400)

        images: List[str] = []
        for p in sorted(img_dir_path.rglob("*")):
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
                rel = p.relative_to(img_dir_path).as_posix()
                gt_label = gt_dir_path / Path(rel).with_suffix(LABEL_EXT)
                if gt_label.is_file():
                    images.append(rel)

        if not images:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "No images with matching GT labels found", "prefill": prefill}, status_code=400)

        def _extract_from_pred_path(dir_path: Path) -> Tuple[str, str]:
            threshold, cls_name = dir_path.name, ""
            for i, part in enumerate(dir_path.parts):
                if part.endswith("_predictions"):
                    threshold = part.replace("_predictions", "")
                    if i > 0:
                        cls_name = dir_path.parts[i - 1]
                    break
            return threshold, cls_name

        thresh_a, cls_a = _extract_from_pred_path(pred_a_path)
        thresh_b, _ = _extract_from_pred_path(pred_b_path) if pred_b_path else ("", "")

        view_data = {
            "mode": mode,
            "images": [{"rel_path": rel} for rel in images],
            "img_dir": str(img_dir_path.resolve()),
            "pred_label_dir_a": str(pred_a_path.resolve()),
            "pred_label_dir_b": str(pred_b_path.resolve()) if pred_b_path else None,
            "gt_label_dir": str(gt_dir_path.resolve()),
            "label_a": thresh_a,
            "label_b": thresh_b or None,
            "compare_class": cls_a,
            "train_file": None,
            "label_dir": None,
        }
        return TEMPLATES.TemplateResponse("viewer.html", {"request": request, "data_json": json.dumps(view_data)})

    if mode == "folder":
        prefill["img_dir"] = img_dir
        if not img_dir:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "Image directory required", "prefill": prefill}, status_code=400)

        img_dir_path = resolve_dataset_path(img_dir)
        if not img_dir_path.exists():
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": f"Invalid image directory: {img_dir}", "prefill": prefill}, status_code=400)

        images = collect_images(img_dir_path, label_dir_path)
        if not images:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "No matching images found", "prefill": prefill}, status_code=400)

        data = {
            "mode": mode,
            "images": [{"rel_path": rel} for rel in images],
            "img_dir": str(img_dir_path.resolve()),
            "label_dir": str(label_dir_path.resolve()) if label_dir_path else None,
            "train_file": None,
        }
    else: # txt
        prefill["train_file"] = train_file
        if not train_file:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "Train file required", "prefill": prefill}, status_code=400)

        train_file_path = resolve_dataset_path(train_file)
        if not train_file_path.exists():
             return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": f"Invalid train file: {train_file}", "prefill": prefill}, status_code=400)

        # label_dir_path can be None for auto-mapping
        entries = load_train_entries(train_file_path, label_dir_path)
        if not entries:
             error_msg = "No valid entries in train file"
             if not label_dir_path:
                 error_msg += " (auto-mapping: ensure paths contain '/images/' and corresponding '/labels/' exists)"
             return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": error_msg, "prefill": prefill}, status_code=400)

        data = {
            "mode": mode,
            "images": [{"rel_path": entry.rel_path, "label_rel": entry.label_rel} for entry in entries],
            "img_dir": None,
            "label_dir": str(label_dir_path.resolve()) if label_dir_path else None,
            "label_mode": "explicit" if label_dir_path else "auto",
            "train_file": str(train_file_path.resolve()),
        }

    return TEMPLATES.TemplateResponse("viewer.html", {"request": request, "data_json": json.dumps(data)})

@app.get("/image")
def get_image(
    mode: str = Query("folder"),
    rel_path: str = Query(...),
    img_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
):
    mode = (mode or "folder").lower()
    try:
        if mode in ("folder", "compare"):
            if not img_dir: raise HTTPException(400, "Image dir required")
            img_dir_path = resolve_dataset_path(img_dir)
            img_path = img_dir_path / rel_path
            if img_path.exists():
                return FileResponse(img_path)
        else:  # txt mode
            if not train_file: raise HTTPException(400, "Train file required")
            train_file_path = resolve_dataset_path(train_file)
            label_dir_path = resolve_dataset_path(label_dir) if label_dir else None
            entry = get_train_entry_by_rel(train_file_path, label_dir_path, rel_path)
            if entry and entry.image_path.is_file():
                return FileResponse(entry.image_path)
            
            # Fallback
            candidate = resolve_path_with_base(rel_path, train_file_path.parent)
            if candidate.exists():
                return FileResponse(candidate)
                
        raise HTTPException(404, f"Image not found: {rel_path}")
    except Exception as e:
        print(f"[ERROR] get_image: {e}")
        raise HTTPException(404, "Image not found")

@app.get("/api/labels")
def get_labels(
    mode: str = Query("folder"),
    rel_path: str = Query(...),
    img_dir: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
):
    mode = (mode or "folder").lower()
    label_path = None

    if mode == "folder":
        if not label_dir: raise HTTPException(400, "Label dir required for folder mode")
        label_dir_path = resolve_dataset_path(label_dir)
        label_path = _find_fuzzy_label(label_dir_path, Path(rel_path))
    else:
        if not train_file: raise HTTPException(400, "Train file required")
        train_file_path = resolve_dataset_path(train_file)
        label_dir_path = resolve_dataset_path(label_dir) if label_dir else None
        entry = get_train_entry_by_rel(train_file_path, label_dir_path, rel_path)
        if entry:
            label_path = entry.label_path

    labels = []
    if label_path and label_path.exists():
        try:
            with label_path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    parts = line.strip().split()
                    if len(parts) >= 5:
                        labels.append({
                            "class": int(float(parts[0])),
                            "bbox": [float(x) for x in parts[1:5]]
                        })
        except Exception:
            pass
            
    return JSONResponse({
        "image": rel_path,
        "label": str(label_path) if label_path else "",
        "labels": labels
    })


def _parse_yolo_labels(label_path: Path, include_conf: bool = False) -> List[dict]:
    labels = []
    if not label_path.exists():
        return labels
    try:
        with label_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                parts = line.strip().split()
                if len(parts) >= 5:
                    entry = {
                        "class": int(float(parts[0])),
                        "bbox": [float(x) for x in parts[1:5]],
                    }
                    if include_conf and len(parts) >= 6:
                        entry["confidence"] = float(parts[5])
                    labels.append(entry)
    except Exception:
        pass
    return labels


@app.get("/api/compare-labels")
def get_compare_labels(
    rel_path: str = Query(...),
    gt_label_dir: str = Query(...),
    pred_label_dir_a: str = Query(...),
    pred_label_dir_b: Optional[str] = Query(None),
):
    gt_dir = resolve_dataset_path(gt_label_dir)
    pred_a_dir = resolve_dataset_path(pred_label_dir_a)
    label_rel = Path(rel_path).with_suffix(LABEL_EXT)

    result: dict = {
        "image": rel_path,
        "gt_labels": _parse_yolo_labels(gt_dir / label_rel, include_conf=False),
        "pred_a_labels": _parse_yolo_labels(pred_a_dir / label_rel, include_conf=True),
    }

    if pred_label_dir_b:
        pred_b_dir = resolve_dataset_path(pred_label_dir_b)
        result["pred_b_labels"] = _parse_yolo_labels(pred_b_dir / label_rel, include_conf=True)

    return JSONResponse(result)


@app.get("/api/annotate/labels")
def get_annotate_labels(
    rel_path: str = Query(...),
    label_dir: str = Query(...),
):
    """
    Get labels for annotate mode (for loading existing labels).
    """
    label_dir_path = resolve_dataset_path(label_dir)
    if not label_dir_path.exists():
        raise HTTPException(404, f"Label directory not found: {label_dir}")
    
    label_rel = Path(rel_path).with_suffix(LABEL_EXT)
    label_path = label_dir_path / label_rel

    labels = []
    if label_path.exists():
        try:
            with label_path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    parts = line.strip().split()
                    if len(parts) >= 5:
                        # [class_id, x_center, y_center, width, height]
                        labels.append([
                            int(float(parts[0])),
                            float(parts[1]),
                            float(parts[2]),
                            float(parts[3]),
                            float(parts[4])
                        ])
        except Exception as e:
            print(f"[ERROR] Failed to read label file {label_path}: {e}")
    
    return JSONResponse({
        "rel_path": rel_path,
        "labels": labels,
        "label_file": str(label_path) if label_path.exists() else None
    })


@app.post("/api/annotate/save")
def save_annotate_labels(request: Request, payload: dict):
    """
    Save labels for annotate mode.
    
    Payload:
    {
        "label_dir": str,          # Label directory path
        "rel_path": str,           # Relative path of image
        "boxes": [[cls, x, y, w, h], ...]  # Bounding boxes in YOLO format
    }
    """
    label_dir = payload.get("label_dir")
    rel_path = payload.get("rel_path")
    boxes = payload.get("boxes", [])
    
    if not label_dir:
        raise HTTPException(400, "Label directory is required")
    if not rel_path:
        raise HTTPException(400, "Relative path is required")
    
    label_dir_path = resolve_dataset_path(label_dir)
    if not label_dir_path.exists():
        raise HTTPException(404, f"Label directory not found: {label_dir}")
    
    # Create label file path
    label_rel = Path(rel_path).with_suffix(LABEL_EXT)
    label_path = label_dir_path / label_rel
    
    # Ensure parent directory exists
    label_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Write YOLO format labels
    try:
        with label_path.open("w", encoding="utf-8") as fh:
            for box in boxes:
                if len(box) >= 5:
                    line = f"{int(box[0])} {box[1]:.6f} {box[2]:.6f} {box[3]:.6f} {box[4]:.6f}"
                    fh.write(line + "\n")
        
        print(f"[INFO] Saved labels to {label_path}")
        return JSONResponse({
            "status": "success",
            "label_file": str(label_path),
            "box_count": len(boxes)
        })
    except Exception as e:
        print(f"[ERROR] Failed to save label file {label_path}: {e}")
        raise HTTPException(500, f"Failed to save labels: {e}")

@app.post("/api/detect")
def detect_objects(request: Request, payload: dict):
    """
    Run YOLO inference on an image and return detected bboxes.
    
    Payload:
    {
        "img_dir": str,           # Base image directory
        "rel_path": str,          # Relative path to image
        "model": str,             # Model name (default: yolo12x)
        "classes": list[int],     # Optional: filter specific class IDs (COCO indices)
        "conf": float             # Optional: confidence threshold (default: 0.25)
    }
    
    Returns:
    {
        "detections": [[class_id, x_center, y_center, width, height, confidence], ...]
    }
    """
    img_dir = resolve_dataset_path(payload.get("img_dir", ""))
    rel_path = payload.get("rel_path", "")
    model_name = payload.get("model", "yolo12x")
    filter_classes = payload.get("classes", None)  # None = all classes
    conf_threshold = payload.get("conf", 0.25)
    
    # Resolve image path
    img_path = img_dir / rel_path
    if not img_path.exists():
        raise HTTPException(status_code=404, detail=f"Image not found: {img_path}")
    
    # Load model
    model = get_yolo_model(model_name)
    
    try:
        # Run inference
        results = model(str(img_path), conf=conf_threshold, verbose=False)
        
        detections = []
        for result in results:
            boxes = result.boxes
            if boxes is None:
                continue
                
            for i in range(len(boxes)):
                cls_id = int(boxes.cls[i].item())
                
                # Filter by class if specified
                if filter_classes is not None and cls_id not in filter_classes:
                    continue
                
                # Get bbox in xywhn format (normalized center x, y, width, height)
                xywhn = boxes.xywhn[i].tolist()
                conf = float(boxes.conf[i].item())
                
                # Format: [class_id, x_center, y_center, width, height, confidence]
                detections.append([
                    cls_id,
                    round(xywhn[0], 6),
                    round(xywhn[1], 6),
                    round(xywhn[2], 6),
                    round(xywhn[3], 6),
                    round(conf, 4)
                ])

        return JSONResponse({
            "status": "success",
            "image": rel_path,
            "detections": detections,
            "count": len(detections)
        })
        
    except Exception as e:
        print(f"[ERROR] Detection failed: {e}")
        raise HTTPException(status_code=500, detail=f"Detection failed: {e}")


@app.get("/api/scan-metrics")
def scan_metrics(base_dir: str = Query(...)):
    base_path = resolve_dataset_path(base_dir)
    if not base_path.exists() or not base_path.is_dir():
        raise HTTPException(404, f"Directory not found: {base_dir}")

    experiments: Dict[str, Dict[str, List[str]]] = {}
    for pred_dir in sorted(base_path.rglob("*_predictions")):
        labels_dir = pred_dir / "images" / "labels"
        if not labels_dir.is_dir():
            continue
        threshold = pred_dir.name.replace("_predictions", "")
        class_name = pred_dir.parent.name
        experiment = pred_dir.parent.parent.name
        if experiment not in experiments:
            experiments[experiment] = {}
        if class_name not in experiments[experiment]:
            experiments[experiment][class_name] = []
        if threshold not in experiments[experiment][class_name]:
            experiments[experiment][class_name].append(threshold)

    return JSONResponse({"experiments": experiments, "base_dir": str(base_path)})


def _container_to_host(path_str: str) -> str:
    """Reverse-map container path back to host path for client display."""
    for host_prefix, container_prefix in PATH_MAPPINGS:
        if path_str.startswith(container_prefix):
            return host_prefix + path_str[len(container_prefix):]
    return path_str


@app.get("/api/browse")
def browse_directory(path: str = Query("~")):
    """List directories and files for the file browser."""
    # Accept host paths: map to container path for actual browsing
    resolved = resolve_dataset_path(path)
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(404, f"Not a directory: {path}")

    dirs = []
    files = []
    try:
        for child in sorted(resolved.iterdir(), key=lambda x: x.name.lower()):
            if child.name.startswith('.'):
                continue
            if child.is_dir():
                dirs.append(child.name)
            elif child.is_file():
                files.append(child.name)
    except PermissionError:
        raise HTTPException(403, "Permission denied")

    # Return host paths so the form values work with resolve_dataset_path
    host_current = _container_to_host(str(resolved))
    host_parent = _container_to_host(str(resolved.parent)) if resolved != resolved.parent else None

    return JSONResponse({
        "current": host_current,
        "parent": host_parent,
        "dirs": dirs,
        "files": files,
    })


@app.get("/api/csv-labels")
def load_csv_labels(path: str = Query(...)):
    """Load CSV label file and return structured data for class auto-assignment."""
    import csv
    resolved = resolve_dataset_path(path)
    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(404, f"File not found: {path}")

    data: Dict[str, Dict[int, int]] = {}
    try:
        with open(resolved, newline='', encoding='utf-8') as f:
            reader = csv.reader(f)
            for row in reader:
                if len(row) < 3:
                    continue
                seq = row[0].strip()
                try:
                    frame = int(row[1])
                    label = int(row[2])
                except ValueError:
                    continue
                if seq not in data:
                    data[seq] = {}
                data[seq][frame] = label
    except Exception as e:
        raise HTTPException(500, f"Failed to parse CSV: {e}")

    return JSONResponse({"data": data})


@app.get("/api/models")
def list_models():
    """List available YOLO models in the model directory"""
    models = []
    if MODEL_DIR.exists():
        for p in MODEL_DIR.iterdir():
            if p.suffix == ".pt":
                models.append(p.stem)
    return JSONResponse({"models": sorted(models)})


@app.get("/api/progress")
def scan_progress(
    mode: str = Query("folder"),
    dataset_dir: Optional[str] = Query(None),
    img_dir: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
    pred_label_dir: Optional[str] = Query(None),
    pred_label_dir_a: Optional[str] = Query(None),
    pred_label_dir_b: Optional[str] = Query(None),
    gt_label_dir: Optional[str] = Query(None),
):
    # dataset_dir 자동 감지
    if dataset_dir and not img_dir:
        _img, _lbl = resolve_dataset_dir(dataset_dir)
        img_dir = str(_img)
        if _lbl and not label_dir:
            label_dir = str(_lbl)

    def event_stream():
        if mode == "compare":
            eff_pred_a = pred_label_dir_a or pred_label_dir
            if not img_dir or not eff_pred_a or not gt_label_dir:
                yield f"data: {json.dumps({'status': 'error', 'message': 'Missing args for compare mode'})}\n\n"
                return
            img_path = resolve_dataset_path(img_dir)
            gt_path = resolve_dataset_path(gt_label_dir)
            if not img_path.exists() or not gt_path.exists():
                yield f"data: {json.dumps({'status': 'error', 'message': 'Invalid paths'})}\n\n"
                return
            images = []
            for p in sorted(img_path.rglob("*")):
                if p.is_file() and p.suffix.lower() in IMAGE_EXTS:
                    rel = p.relative_to(img_path).as_posix()
                    if (gt_path / Path(rel).with_suffix(LABEL_EXT)).is_file():
                        images.append(rel)
        elif mode == "folder":
            if not img_dir:
                yield f"data: {json.dumps({'status': 'error', 'message': 'Missing img_dir'})}\n\n"
                return
            img_path = resolve_dataset_path(img_dir)
            if not img_path.exists():
                yield f"data: {json.dumps({'status': 'error', 'message': 'Invalid image directory'})}\n\n"
                return
            lbl_path = resolve_dataset_path(label_dir) if label_dir else None
            if lbl_path and not lbl_path.exists():
                lbl_path = None
            images = list_images(img_path, lbl_path)
        else:
            if not train_file:
                yield f"data: {json.dumps({'status': 'error', 'message': 'Missing train file'})}\n\n"
                return
            tf_path = resolve_dataset_path(train_file)
            if not tf_path.exists():
                yield f"data: {json.dumps({'status': 'error', 'message': f'Train file not found: {train_file}'})}\n\n"
                return
            ld_path = resolve_dataset_path(label_dir) if label_dir else None
            try:
                entries = load_train_entries(tf_path, ld_path)
            except Exception as e:
                yield f"data: {json.dumps({'status': 'error', 'message': f'Failed to load train file: {str(e)}'})}\n\n"
                return
            images = [e.rel_path for e in entries]

        total = len(images)
        if total == 0:
            yield f"data: {json.dumps({'status': 'error', 'message': 'No images found'})}\n\n"
            return

        # Fast progress simulation since list is already loaded
        yield f"data: {json.dumps({'status': 'progress', 'progress': 100, 'eta': 0})}\n\n"

        params = [("mode", mode)]
        if mode == "compare":
            eff_pred_a = pred_label_dir_a or pred_label_dir
            params.extend([("img_dir", img_dir), ("pred_label_dir_a", eff_pred_a), ("gt_label_dir", gt_label_dir)])
            if pred_label_dir_b:
                params.append(("pred_label_dir_b", pred_label_dir_b))
        elif mode == "folder":
            params.extend([("label_dir", label_dir), ("img_dir", img_dir)])
        else:
            if label_dir: params.append(("label_dir", label_dir))
            params.append(("train_file", train_file))
        
        q = "&".join(f"{k}={quote(v, safe='')}" for k, v in params if v)
        yield f"data: {json.dumps({'status': 'done', 'viewer_url': f'/viewer?{q}'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
