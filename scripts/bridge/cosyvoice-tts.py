# -*- coding: utf-8 -*-
"""SKF M26 · CosyVoice2 零样本克隆配音桥（cosyvoice venv 解释器运行）。
用法: python cosyvoice-tts.py --text <文本> --out <绝对输出 wav 路径>
stdout 输出单行 JSON: {"status":"ok","path":...,"duration":...} 或 {"status":"failed","detail":...}
固定参考音（小六声音）与参考文本来自 SETUP-REPORT；可经 env 覆盖：
  SKF_COSYVOICE_REF16 / SKF_COSYVOICE_REF_TEXT / SKF_COSYVOICE_MODEL_DIR
"""
import sys, time, os, argparse, json

REF16 = os.environ.get('SKF_COSYVOICE_REF16', r'D:/AI/outputs/ref_xiaoxiao_16k.wav')
REF_TXT = os.environ.get('SKF_COSYVOICE_REF_TEXT', '你好，我是小六，你的AI搭档。这句话用来测试本地语音克隆和识别效果。')
MODEL_DIR = os.environ.get('SKF_COSYVOICE_MODEL_DIR', r'D:/AI/models/tts/CosyVoice2-0.5B')

sys.path.insert(0, r'D:/AI/CosyVoice')
sys.path.insert(0, r'D:/AI/CosyVoice/third_party/Matcha-TTS')

try:
    import soundfile as sf
    import torch, torchaudio
except Exception as ex:
    print(json.dumps({'status': 'failed', 'detail': 'import failed: ' + repr(ex)}, ensure_ascii=False))
    sys.exit(1)


def load_wav_sf(wav, target_sr, min_sr=16000):
    """soundfile 版 load_wav，绕过 torchcodec DLL 加载失败问题。"""
    if isinstance(wav, torch.Tensor):
        speech, sample_rate = wav, target_sr
    else:
        y, sample_rate = sf.read(wav, dtype='float32', always_2d=True)
        speech = torch.from_numpy(y.T)
    speech = speech.mean(dim=0, keepdim=True)
    if sample_rate != target_sr:
        speech = torchaudio.functional.resample(speech, sample_rate, target_sr)
    return speech


try:
    from cosyvoice.cli.cosyvoice import CosyVoice2
    import cosyvoice.utils.file_utils as fu
    import cosyvoice.cli.frontend as fe
    fu.load_wav = load_wav_sf
    fe.load_wav = load_wav_sf
except Exception as ex:
    print(json.dumps({'status': 'failed', 'detail': 'CosyVoice2 import failed: ' + repr(ex)}, ensure_ascii=False))
    sys.exit(1)

ap = argparse.ArgumentParser()
ap.add_argument('--text', required=True)
ap.add_argument('--out', required=True)
args = ap.parse_args()

if not os.path.exists(REF16):
    print(json.dumps({'status': 'failed', 'detail': 'reference voice missing: ' + REF16}, ensure_ascii=False))
    sys.exit(1)

try:
    t0 = time.time()
    cv = CosyVoice2(MODEL_DIR, load_jit=False, load_trt=False, load_vllm=False, fp16=False)
    for j in cv.inference_zero_shot(args.text, REF_TXT, REF16, stream=False):
        audio = j['tts_speech'].squeeze(0).cpu().numpy()
        sf.write(args.out, audio, cv.sample_rate)
    y, sr = sf.read(args.out)
    print(json.dumps({
        'status': 'ok',
        'path': args.out,
        'sr': int(sr),
        'duration': round(len(y) / sr, 2),
        'seconds': round(time.time() - t0, 2),
    }, ensure_ascii=False))
except Exception as ex:
    print(json.dumps({'status': 'failed', 'detail': repr(ex)[:500]}, ensure_ascii=False))
    sys.exit(1)
