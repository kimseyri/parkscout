"""YOLOv8n ONNX vehicle detector — shared by the GitHub Action scraper and local tests.

Pure numpy pre/post-processing; only onnxruntime + Pillow needed at inference time.
"""
import numpy as np
from PIL import Image

VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}  # COCO ids
INPUT = 640


def nms(boxes, scores, iou_thres):
    """boxes: (N,4) xyxy. Returns kept indices, score-descending."""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1).clip(0) * (y2 - y1).clip(0)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest]); yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest]); yy2 = np.minimum(y2[i], y2[rest])
        inter = (xx2 - xx1).clip(0) * (yy2 - yy1).clip(0)
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou <= iou_thres]
    return keep


class Detector:
    def __init__(self, model_path, conf=0.30, iou=0.45):
        import onnxruntime as ort
        self.sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0].name
        self.conf = conf
        self.iou = iou

    def detect(self, img):
        """img: PIL.Image. Returns [(x1, y1, x2, y2, conf, class_id)] in original coords."""
        w0, h0 = img.size
        r = min(INPUT / w0, INPUT / h0)
        nw, nh = round(w0 * r), round(h0 * r)
        pad_x, pad_y = (INPUT - nw) / 2, (INPUT - nh) / 2
        canvas = Image.new("RGB", (INPUT, INPUT), (114, 114, 114))
        canvas.paste(img.convert("RGB").resize((nw, nh), Image.BILINEAR),
                     (round(pad_x), round(pad_y)))
        x = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
        out = self.sess.run(None, {self.inp: x})[0][0]  # (84, 8400)
        preds = out.T
        scores = preds[:, 4:]
        cls_ids = scores.argmax(1)
        confs = scores[np.arange(len(preds)), cls_ids]
        keep = (confs >= self.conf) & np.isin(cls_ids, list(VEHICLE_CLASSES))
        if not keep.any():
            return []
        boxes, confs, cls_ids = preds[keep, :4], confs[keep], cls_ids[keep]
        xyxy = np.concatenate([boxes[:, :2] - boxes[:, 2:4] / 2,
                               boxes[:, :2] + boxes[:, 2:4] / 2], 1)
        xyxy[:, [0, 2]] = ((xyxy[:, [0, 2]] - pad_x) / r).clip(0, w0)
        xyxy[:, [1, 3]] = ((xyxy[:, [1, 3]] - pad_y) / r).clip(0, h0)
        kept = nms(xyxy, confs, self.iou)
        return [(float(x1), float(y1), float(x2), float(y2), float(c), int(k))
                for (x1, y1, x2, y2), c, k in zip(xyxy[kept], confs[kept], cls_ids[kept])]
