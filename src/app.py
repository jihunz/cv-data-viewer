from __future__ import annotations

import io
import json
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

# --- Data Roots (Modified for user env) ---
HOST_DATA_ROOT = Path("/Users/jihunjang/Downloads")
CONTAINER_DATA_ROOT = Path("/datasets")

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
DATASET_MODES = {"folder", "txt", "annotate"}

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
    
    # 1. Direct Check (If path is already /datasets/...)
    if candidate.exists():
        return candidate.resolve()

    # 2. Host Path Mapping
    # Calculate relative path from HOST_DATA_ROOT
    try:
        # Force resolving to absolute paths to handle symlinks or ../
        abs_raw = Path(path_str).expanduser().resolve()
        # We can't resolve HOST_DATA_ROOT inside container if it doesn't exist, 
        # so we use string manipulation.
        
        host_root_str = str(HOST_DATA_ROOT)
        input_str = str(abs_raw)
        
        if input_str.startswith(host_root_str):
            rel_part = input_str[len(host_root_str):].lstrip("/")
            mapped = (CONTAINER_DATA_ROOT / rel_part).resolve()
            
            print(f"[DEBUG] Mapping: {input_str} -> {mapped}")
            
            if mapped.exists():
                return mapped
            else:
                print(f"[ERROR] Mapped path does not exist in container. Mount mismatch?")
                print(f"[INFO] Expected: {mapped}")
                print(f"[INFO] Actual /datasets content: {[p.name for p in CONTAINER_DATA_ROOT.iterdir()]}")
                
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


def auto_find_label_from_image_path(image_path: Path) -> Optional[Path]:
    """
    Automatically find label by replacing '/images/' with '/labels/' in path.
    Example:
      /path/to/megafallv2/images/train/image.jpg -> /path/to/megafallv2/labels/train/image.txt
    """
    path_str = str(image_path)
    
    # Replace '/images/' with '/labels/'
    if '/images/' in path_str:
        label_str = path_str.replace('/images/', '/labels/', 1)
        # Change extension to .txt
        label_path = Path(label_str).with_suffix(LABEL_EXT)
        if label_path.exists():
            return label_path
    
    return None

def load_train_entries(train_file_path: Path, label_dir_path: Optional[Path] = None) -> List[TxtEntry]:
    """
    Load train entries from a train file.
    
    If label_dir_path is provided, looks for labels in that directory.
    If label_dir_path is None, auto-maps by replacing '/images/' with '/labels/' in image path.
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
            
            # Find label - auto mapping or from label_dir
            if label_dir_path:
                label_info = find_label_for_image(image_path_candidate, label_dir_path)
                if not label_info:
                    continue
                rel_path, label_rel, label_abs = label_info
            else:
                # Auto mapping: /images/ -> /labels/
                label_abs = auto_find_label_from_image_path(image_path_candidate)
                if not label_abs:
                    continue
                # Use image filename as rel_path
                rel_path = image_path_candidate.name
                label_rel = label_abs.name
            
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

def list_images(img_dir: Path, label_dir: Path) -> List[str]:
    images: List[str] = []
    # Only scan depth 1 and direct subdirs
    if not img_dir.exists(): 
        return []
        
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
    img_dir: str = Query(..., description="Path to image directory"),
    label_dir: Optional[str] = Query(None, description="Path to label directory (optional, for loading existing labels)"),
):
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

@app.post("/api/export")
def export_dataset(request: Request, payload: dict):
    img_dir = resolve_dataset_path(payload["img_dir"])
    target_w, target_h = payload["target_size"]
    annotations = payload["annotations"]

    zip_buffer = io.BytesIO()
    
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel_path, boxes in annotations.items():
            try:
                src_path = img_dir / rel_path # Simple join
                if not src_path.exists():
                    print(f"[WARN] Image not found: {src_path}")
                    continue
                    
                with Image.open(src_path) as img:
                    # Convert to RGB if RGBA
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

    zip_buffer.seek(0)
    filename = f"dataset_{int(time.time())}.zip"
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

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

    # Resolve label_dir if provided
    label_dir_path = None
    if label_dir:
        label_dir_path = resolve_dataset_path(label_dir)
        if not label_dir_path.exists():
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": f"Invalid label directory: {label_dir}", "prefill": prefill}, status_code=400)

    if mode == "folder":
        # Folder mode requires label_dir
        if not label_dir:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "Label directory is required for folder mode.", "prefill": prefill}, status_code=400)
        
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
            "label_dir": str(label_dir_path.resolve()),
            "train_file": None,
        }
    else: # txt mode - supports auto label mapping
        prefill["train_file"] = train_file
        if not train_file:
            return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": "Train file required", "prefill": prefill}, status_code=400)

        train_file_path = resolve_dataset_path(train_file)
        if not train_file_path.exists():
             return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": f"Invalid train file: {train_file}", "prefill": prefill}, status_code=400)

        # Load entries - if label_dir is None, uses auto-mapping (images/ -> labels/)
        entries = load_train_entries(train_file_path, label_dir_path)
        if not entries:
             error_msg = "No valid entries in train file"
             if not label_dir:
                 error_msg += " (auto-mapping: /images/ -> /labels/)"
             return TEMPLATES.TemplateResponse("index.html", {"request": request, "error": error_msg, "prefill": prefill}, status_code=400)

        data = {
            "mode": mode,
            "images": [{"rel_path": entry.rel_path, "label_rel": entry.label_rel, "image_path": str(entry.image_path), "label_path": str(entry.label_path)} for entry in entries],
            "img_dir": None,
            "label_dir": str(label_dir_path.resolve()) if label_dir_path else "auto",
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
    image_path_direct: Optional[str] = Query(None),  # Direct image path for auto-mapping mode
):
    mode = (mode or "folder").lower()
    try:
        if mode == "folder":
            if not img_dir: raise HTTPException(400, "Image dir required")
            img_dir_path = resolve_dataset_path(img_dir)
            img_path = img_dir_path / rel_path
            if img_path.exists():
                return FileResponse(img_path)
        else:
            # txt mode - try direct path first (for auto-mapping mode)
            if image_path_direct:
                direct_path = Path(image_path_direct)
                if direct_path.exists():
                    return FileResponse(direct_path)
            
            if not train_file: raise HTTPException(400, "Train file required")
            train_file_path = resolve_dataset_path(train_file)
            label_dir_path = resolve_dataset_path(label_dir) if label_dir and label_dir != "auto" else None
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
    label_path_direct: Optional[str] = Query(None),  # Direct label path for auto-mapping mode
):
    mode = (mode or "folder").lower()
    label_path = None

    if mode == "folder":
        if not label_dir: raise HTTPException(400, "Label dir required")
        label_dir_path = resolve_dataset_path(label_dir)
        label_rel = Path(rel_path).with_suffix(LABEL_EXT)
        label_path = label_dir_path / label_rel
    else:
        # txt mode
        if label_path_direct:
            # Direct label path provided (for auto-mapping mode)
            label_path = Path(label_path_direct)
        elif train_file:
            train_file_path = resolve_dataset_path(train_file)
            label_dir_path = resolve_dataset_path(label_dir) if label_dir and label_dir != "auto" else None
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
    img_dir: Optional[str] = Query(None),
    label_dir: Optional[str] = Query(None),
    train_file: Optional[str] = Query(None),
):
    def event_stream():
        # (Simplified for brevity - using same logic as before but ensuring no syntax errors)
        if mode == "folder":
            if not img_dir or not label_dir:
                yield f"data: {json.dumps({'status': 'error', 'message': 'Missing args for folder mode'})}\n\n"
                return
            img_path = resolve_dataset_path(img_dir)
            lbl_path = resolve_dataset_path(label_dir)
            if not img_path.exists() or not lbl_path.exists():
                yield f"data: {json.dumps({'status': 'error', 'message': 'Invalid paths'})}\n\n"
                return
            images = list_images(img_path, lbl_path)
        else:
            # txt mode - label_dir is optional (auto-mapping)
            if not train_file:
                yield f"data: {json.dumps({'status': 'error', 'message': 'Missing train file'})}\n\n"
                return
            tf_path = resolve_dataset_path(train_file)
            ld_path = resolve_dataset_path(label_dir) if label_dir else None
            entries = load_train_entries(tf_path, ld_path)
            images = [e.rel_path for e in entries]

        total = len(images)
        if total == 0:
            error_msg = 'No images found'
            if mode == 'txt' and not label_dir:
                error_msg += ' (auto-mapping: /images/ → /labels/)'
            yield f"data: {json.dumps({'status': 'error', 'message': error_msg})}\n\n"
            return

        # Fast progress simulation since list is already loaded
        yield f"data: {json.dumps({'status': 'progress', 'progress': 100, 'eta': 0})}\n\n"

        params = [("mode", mode)]
        if label_dir:
            params.append(("label_dir", label_dir))
        if mode == "folder": 
            params.append(("img_dir", img_dir))
        else: 
            params.append(("train_file", train_file))
        
        q = "&".join(f"{k}={quote(v, safe='')}" for k, v in params if v)
        yield f"data: {json.dumps({'status': 'done', 'viewer_url': f'/viewer?{q}'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
