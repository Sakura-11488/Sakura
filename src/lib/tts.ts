import { Capacitor } from "@capacitor/core";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

export interface TTSOptions {
    rate?: number;
    pitch?: number;
    voiceURI?: string;
    lang?: string;
}

export interface TTSVoice {
    voiceURI: string;
    name: string;
    lang: string;
}

const isNative = () => Capacitor.isNativePlatform();

let webChunks: string[] = [];
let webChunkIndex = 0;
let webKeepAlive: ReturnType<typeof setInterval> | null = null;
let webSpeaking = false;
let onEndCallback: (() => void) | null = null;
let onChunkCallback: ((index: number, total: number) => void) | null = null;
let nativeStopped = false;

function webCleanup() {
    if (webKeepAlive) { clearInterval(webKeepAlive); webKeepAlive = null; }
    webChunks = [];
    webChunkIndex = 0;
    webSpeaking = false;
}

function speakWebChunk(index: number, opts: TTSOptions) {
    const synth = window.speechSynthesis;
    if (!synth || index >= webChunks.length) {
        webCleanup();
        onEndCallback?.();
        return;
    }
    webChunkIndex = index;
    onChunkCallback?.(index, webChunks.length);

    const utt = new SpeechSynthesisUtterance(webChunks[index]);
    utt.rate = opts.rate ?? 1;
    utt.pitch = opts.pitch ?? 1;
    if (opts.voiceURI) {
        const v = synth.getVoices().find(voice => voice.voiceURI === opts.voiceURI);
        if (v) utt.voice = v;
    }
    utt.onend = () => speakWebChunk(index + 1, opts);
    utt.onerror = (e) => {
        if (e.error === "canceled" || e.error === "interrupted") return;
        speakWebChunk(index + 1, opts);
    };
    synth.speak(utt);
}

function chunkText(text: string, maxLen = 3000): string[] {
    const chunks: string[] = [];
    const sentences = text.replace(/([.!?。！？])\s*/g, "$1\n").split("\n").filter(s => s.trim());
    let current = "";
    for (const sentence of sentences) {
        if (current.length + sentence.length > maxLen && current) {
            chunks.push(current.trim());
            current = "";
        }
        current += sentence + " ";
    }
    if (current.trim()) chunks.push(current.trim());
    if (chunks.length === 0 && text.length > 0) chunks.push(text.slice(0, maxLen));
    return chunks;
}

async function speakNativeChunked(
    text: string,
    opts: TTSOptions,
    callbacks?: { onEnd?: () => void; onChunk?: (index: number, total: number) => void }
): Promise<void> {
    nativeStopped = false;
    const chunks = chunkText(text, 3000);

    for (let i = 0; i < chunks.length; i++) {
        if (nativeStopped) break;
        callbacks?.onChunk?.(i, chunks.length);
        try {
            await TextToSpeech.speak({
                text: chunks[i],
                rate: opts.rate ?? 1.0,
                pitch: opts.pitch ?? 1.0,
                lang: opts.lang ?? "en-US",
                category: "playback",
            });
        } catch (err) {
            if (nativeStopped) break;
            console.error("Native TTS chunk error:", err);
            continue;
        }
    }
    if (!nativeStopped) {
        callbacks?.onEnd?.();
    }
}

export async function ttsSpeak(
    text: string,
    opts: TTSOptions = {},
    callbacks?: { onEnd?: () => void; onChunk?: (index: number, total: number) => void }
): Promise<void> {
    onEndCallback = callbacks?.onEnd ?? null;
    onChunkCallback = callbacks?.onChunk ?? null;

    if (isNative()) {
        await speakNativeChunked(text, opts, callbacks);
        return;
    }

    const synth = window.speechSynthesis;
    if (!synth) throw new Error("TTS_NOT_SUPPORTED");

    synth.cancel();
    webCleanup();

    webChunks = chunkText(text, 800);
    webSpeaking = true;

    webKeepAlive = setInterval(() => {
        if (synth.speaking && !synth.paused) {
            synth.pause();
            synth.resume();
        }
    }, 10000);

    speakWebChunk(0, opts);
}

export async function ttsStopAll(): Promise<void> {
    nativeStopped = true;
    if (isNative()) {
        try { await TextToSpeech.stop(); } catch { /* already stopped */ }
    }
    window.speechSynthesis?.cancel();
    webCleanup();
}

export function ttsPauseWeb(): void {
    window.speechSynthesis?.pause();
    if (webKeepAlive) { clearInterval(webKeepAlive); webKeepAlive = null; }
}

export function ttsResumeWeb(): void {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.resume();
    if (!webKeepAlive) {
        webKeepAlive = setInterval(() => {
            if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
        }, 10000);
    }
}

export async function ttsGetVoices(): Promise<TTSVoice[]> {
    if (isNative()) {
        try {
            const result = await TextToSpeech.getSupportedVoices();
            return (result.voices || []).map(v => ({
                voiceURI: v.voiceURI,
                name: v.name,
                lang: v.lang,
            }));
        } catch {
            return [];
        }
    }

    const synth = window.speechSynthesis;
    if (!synth) return [];
    let voices = synth.getVoices();
    if (voices.length === 0) {
        await new Promise<void>(resolve => {
            synth.onvoiceschanged = () => resolve();
            setTimeout(resolve, 2000);
        });
        voices = synth.getVoices();
    }
    return voices.map(v => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang }));
}

export function ttsIsSupported(): boolean {
    if (isNative()) return true;
    return typeof window !== "undefined" && !!window.speechSynthesis;
}

export function ttsIsNative(): boolean {
    return isNative();
}

export function ttsGetWebChunkInfo(): { index: number; total: number } {
    return { index: webChunkIndex, total: webChunks.length };
}

export function ttsIsWebSpeaking(): boolean {
    return webSpeaking;
}
