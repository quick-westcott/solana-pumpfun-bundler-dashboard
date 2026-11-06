import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { UPLOADS_DIR } from '../paths';

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname).toLowerCase() || '.png'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // No SVG: it can carry scripts and /api/uploads serves files same-origin.
    const ok = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(path.extname(file.originalname).toLowerCase());
    if (ok) cb(null, true); else cb(new Error('Only png, jpg, gif or webp images are allowed'));
  },
});

const router = Router();

/** multipart field "image" → { url: "/api/uploads/<file>" }, the value the Launch form puts in imageUrl. */
router.post('/image', (req: Request, res: Response) => {
  upload.single('image')(req, res, (err: unknown) => {
    if (err) return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    res.json({ url: `/api/uploads/${req.file.filename}`, filename: req.file.filename });
  });
});

export default router;
