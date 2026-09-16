# -*- coding: utf-8 -*-
"""SKF M26 · faster-whisper 转写桥（f5tts venv 解释器运行）。
用法: python whisper-transcribe.py --audio <path> [--model large-v3-turbo] [--language zh]
stdout 输出单行 JSON: {"status":"ok","text":...} 或 {"status":"failed","detail":...}
"""
import os, sys, glob, json, time, argparse

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
# 让 CTranslate2 找到 pip 版 CUDA12 运行库 DLL
_site = os.path.join(os.path.dirname(os.path.dirname(sys.executable)), 'Lib', 'site-packages')
for _d in glob.glob(os.path.join(_site, 'nvidia', '*', 'bin')):
    try:
        os.add_dll_directory(_d)
    except Exception:
        pass
    os.environ['PATH'] = _d + os.pathsep + os.environ.get('PATH', '')

try:
    from faster_whisper import WhisperModel
except Exception as ex:
    print(json.dumps({'status': 'failed', 'detail': 'faster_whisper import failed: ' + repr(ex)}, ensure_ascii=False))
    sys.exit(1)

ap = argparse.ArgumentParser()
ap.add_argument('--audio', required=True)
ap.add_argument('--model', default='large-v3-turbo')
ap.add_argument('--language', default='zh')
args = ap.parse_args()

if not os.path.exists(args.audio):
    print(json.dumps({'status': 'failed', 'detail': 'audio not found: ' + args.audio}, ensure_ascii=False))
    sys.exit(1)

try:
    t0 = time.time()
    model = WhisperModel(args.model, device='cuda', compute_type='float16')
    segments, info = model.transcribe(args.audio, language=args.language, vad_filter=True)
    seg_list = [{'start': round(s.start, 3), 'end': round(s.end, 3), 'text': s.text.strip()} for s in segments]
    text = ''.join(s['text'] for s in seg_list).strip()
    print(json.dumps({
        'status': 'ok',
        'text': text,
        'language': info.language,
        'duration': round(info.duration, 3) if info.duration else None,
        'segments': seg_list,
        'seconds': round(time.time() - t0, 2),
    }, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'status': 'failed', 'detail': repr(ex)[:500]}, ensure_ascii=False))
    sys.exit(1)
