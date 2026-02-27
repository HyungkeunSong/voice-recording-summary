"use client";

import { useState, useRef, useEffect } from "react";
import type { Summary, TranscribeResult } from "@/app/types";

type Result = TranscribeResult;

type ProcessingStep = "idle" | "converting" | "transcribing" | "summarizing" | "done" | "error";

const STORAGE_KEY = "voice-summary-result";

/** 브라우저에서 오디오 파일을 8kHz mono WAV로 변환 (Vercel 4.5MB body limit 대응) */
async function convertToWav(file: File): Promise<Blob> {
  const arrayBuffer = await file.arrayBuffer();

  // 1) 원본 샘플레이트로 디코딩
  const tempCtx = new AudioContext();
  const decoded = await tempCtx.decodeAudioData(arrayBuffer);
  tempCtx.close();

  // 2) OfflineAudioContext로 8kHz mono 리샘플링
  //    Whisper는 내부적으로 16kHz로 리샘플링하므로 8kHz 입력도 문제없음
  //    3분 30초 기준: 8000 * 210 * 2 = 3.36MB (Vercel 4.5MB 제한 이내)
  const TARGET_RATE = 8000;
  const duration = decoded.duration;
  const offlineLength = Math.ceil(duration * TARGET_RATE);
  const offline = new OfflineAudioContext(1, offlineLength, TARGET_RATE);

  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  const mono = rendered.getChannelData(0);

  // 3) Float32 → Int16
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // 4) WAV 헤더 + PCM 데이터
  const dataSize = pcm.length * 2;
  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666D7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataSize, true);

  new Uint8Array(wavBuffer).set(new Uint8Array(pcm.buffer), 44);

  return new Blob([wavBuffer], { type: "audio/wav" });
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ProcessingStep>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState<string>("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [savedFileName, setSavedFileName] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // localStorage에서 이전 결과 복원
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { result: Result; fileName: string };
        setResult(parsed.result);
        setSavedFileName(parsed.fileName);
        setStep("done");
      }
    } catch { /* corrupt storage */ }
  }, []);

  // 경과 시간 타이머
  useEffect(() => {
    if (step !== "converting" && step !== "transcribing" && step !== "summarizing") {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [step]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setResult(null);
      setError("");
      setStep("idle");
      setSavedFileName("");
    }
  };

  const handleSubmit = async () => {
    if (!file) return;

    setError("");
    setResult(null);
    setSavedFileName("");

    try {
      // Step 1: 브라우저에서 WAV 변환
      setStep("converting");

      let wavBlob: Blob;
      try {
        wavBlob = await convertToWav(file);
      } catch {
        throw new Error("이 파일 형식을 변환할 수 없습니다. 다른 녹음 파일을 시도해주세요.");
      }

      // Vercel serverless 함수 body 제한 4.5MB 체크
      if (wavBlob.size > 4 * 1024 * 1024) {
        throw new Error(
          `변환된 파일이 너무 큽니다 (${(wavBlob.size / (1024 * 1024)).toFixed(1)}MB). ` +
          `10분 이하의 녹음 파일을 사용해주세요.`
        );
      }

      // Step 2: 서버에 WAV 전송 → Whisper 전사
      setStep("transcribing");

      const formData = new FormData();
      formData.append("file", new File([wavBlob], "audio.wav", { type: "audio/wav" }));

      const transcribeController = new AbortController();
      const transcribeTimeout = setTimeout(() => transcribeController.abort(), 90000);

      const transcribeRes = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
        signal: transcribeController.signal,
      });
      clearTimeout(transcribeTimeout);

      if (!transcribeRes.ok) {
        let errorMsg = "텍스트 추출 중 오류가 발생했습니다.";
        try {
          const data = await transcribeRes.json();
          errorMsg = data.error || errorMsg;
        } catch {
          if (transcribeRes.status === 504) {
            errorMsg = "텍스트 추출 시간이 초과되었습니다. 파일이 너무 길 수 있습니다.";
          } else {
            errorMsg = `서버 오류 (${transcribeRes.status}). 잠시 후 다시 시도해주세요.`;
          }
        }
        throw new Error(errorMsg);
      }

      const transcribeData = await transcribeRes.json();
      const { transcript, partialFailure } = transcribeData as {
        transcript: string;
        partialFailure?: string;
      };

      // Step 3: 요약
      setStep("summarizing");

      const summarizeController = new AbortController();
      const summarizeTimeout = setTimeout(() => summarizeController.abort(), 90000);

      const summarizeRes = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
        signal: summarizeController.signal,
      });
      clearTimeout(summarizeTimeout);

      if (!summarizeRes.ok) {
        let errorMsg = "요약 중 오류가 발생했습니다.";
        try {
          const data = await summarizeRes.json();
          errorMsg = data.error || errorMsg;
        } catch {
          if (summarizeRes.status === 504) {
            errorMsg = "요약 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.";
          } else {
            errorMsg = `서버 오류 (${summarizeRes.status}). 잠시 후 다시 시도해주세요.`;
          }
        }
        throw new Error(errorMsg);
      }

      const summarizeData = await summarizeRes.json();
      const { summary } = summarizeData as { summary: Summary };

      const finalResult: Result = { transcript, summary, partialFailure };
      setResult(finalResult);
      setStep("done");

      // localStorage에 결과 저장
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          result: finalResult,
          fileName: file.name,
        }));
      } catch { /* storage full */ }
    } catch (err: unknown) {
      let message: string;
      if (err instanceof DOMException && err.name === "AbortError") {
        message = "처리 시간이 초과되었습니다. 파일이 너무 길 수 있습니다.";
      } else {
        message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
      }
      setError(message);
      setStep("error");
    }
  };

  const clearSavedResult = () => {
    localStorage.removeItem(STORAGE_KEY);
    setResult(null);
    setSavedFileName("");
    setStep("idle");
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    }
  };

  const formatFullReport = (r: Result): string => {
    const now = new Date().toLocaleString("ko-KR");
    return `녹음 요약 리포트
생성일시: ${now}
${"=".repeat(40)}

[간단 요약]
${r.summary.briefSummary}

[통화 상대방]
${r.summary.participants}

[핵심 내용]
${r.summary.keyPoints}

[약속/합의 사항]
${r.summary.agreements}

[법적 중요 발언]
${r.summary.legallySignificant}

[주의할 점]
${r.summary.cautions}

${"=".repeat(40)}
[전체 텍스트]
${r.transcript}`;
  };

  const downloadReport = () => {
    if (!result) return;
    const content = formatFullReport(result);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
    a.href = url;
    a.download = `녹음요약_${dateStr}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatDetailedAnalysis = (summary: Summary): string => {
    return `[통화 상대방]
${summary.participants}

[핵심 내용]
${summary.keyPoints}

[약속/합의 사항]
${summary.agreements}

[법적 중요 발언]
${summary.legallySignificant}

[주의할 점]
${summary.cautions}`;
  };

  const isProcessing = step === "converting" || step === "transcribing" || step === "summarizing";

  const stepLabel = step === "converting" ? "파일 변환 중"
    : step === "transcribing" ? "텍스트 추출 중"
    : step === "summarizing" ? "요약 중" : "";

  const stepIndex = step === "converting" ? 0 : step === "transcribing" ? 1 : step === "summarizing" ? 2 : -1;

  return (
    <main className="min-h-screen px-4 py-6 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-center mb-1">녹음 요약 도구</h1>
      <p className="text-sm text-gray-400 text-center mb-6">삼촌이 깨어나길 기도합니다</p>

      {/* 이전 결과 알림 */}
      {savedFileName && !isProcessing && (
        <div className="mb-4 p-3 bg-gray-50 rounded-2xl flex items-center justify-between">
          <p className="text-sm text-gray-600 truncate mr-2">이전 결과: {savedFileName}</p>
          <button
            onClick={clearSavedResult}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-200 text-gray-600 active:bg-gray-300 shrink-0"
          >
            새로 시작
          </button>
        </div>
      )}

      {/* 파일 선택 */}
      <div className="mb-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.m4a,.mp3,.aac,.amr,.wav,.ogg,.webm,.flac"
          onChange={handleFileChange}
          className="hidden"
        />
        {isProcessing ? (
          <p className="text-sm text-gray-500 text-center truncate px-2">
            {file?.name} ({(file!.size / (1024 * 1024)).toFixed(1)}MB)
          </p>
        ) : (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-4 px-6 bg-white border-2 border-dashed border-gray-300 rounded-2xl text-lg font-medium text-gray-600 active:bg-gray-100 truncate"
            >
              {file ? file.name : "녹음 파일 선택"}
            </button>
            {file && (
              <p className="mt-2 text-sm text-gray-500 text-center">
                {(file.size / (1024 * 1024)).toFixed(1)}MB
              </p>
            )}
          </>
        )}
      </div>

      {/* 변환 버튼 — 처리 중에는 숨김 */}
      {!isProcessing && (
        <button
          onClick={handleSubmit}
          disabled={!file}
          className="w-full py-4 px-6 bg-blue-600 text-white text-lg font-bold rounded-2xl active:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 mb-6"
        >
          변환 시작
        </button>
      )}

      {/* 진행 상태 */}
      {isProcessing && (
        <div className="mb-6 p-4 bg-blue-50 rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-blue-800 font-medium">
              {stepLabel}... ({elapsedSeconds}초 경과)
            </span>
          </div>
          <p className="mt-2 text-sm text-blue-600">
            {step === "converting"
              ? "브라우저에서 오디오 파일을 변환하고 있습니다."
              : step === "transcribing"
              ? "음성을 텍스트로 변환하고 있습니다."
              : "텍스트를 분석하고 요약하고 있습니다."}
          </p>
          {/* 3단계 진행바 */}
          <div className="mt-3 flex gap-1.5">
            {["변환", "추출", "요약"].map((label, i) => (
              <div key={label} className="flex-1">
                <div className={`h-1.5 rounded-full ${i <= stepIndex ? (i === stepIndex ? "bg-blue-400 animate-pulse" : "bg-blue-400") : "bg-gray-200"}`} />
                <p className="mt-1 text-xs text-blue-500 text-center">{label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 에러 */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 rounded-2xl">
          <p className="text-red-700 font-medium whitespace-pre-wrap">{error}</p>
          {file && (
            <button
              onClick={handleSubmit}
              className="mt-3 w-full py-3 bg-red-600 text-white font-bold rounded-xl active:bg-red-700"
            >
              다시 시도
            </button>
          )}
        </div>
      )}

      {/* 결과 */}
      {result && (
        <div className="space-y-4">
          {/* 부분 실패 경고 */}
          {result.partialFailure && (
            <div className="p-3 bg-yellow-50 rounded-2xl border border-yellow-200">
              <p className="text-yellow-800 text-sm font-medium">{result.partialFailure}</p>
            </div>
          )}

          <ResultSection
            title="간단 요약"
            content={result.summary.briefSummary}
            onCopy={() => copyToClipboard(result.summary.briefSummary, "brief")}
            isCopied={copied === "brief"}
          />

          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold">상세 분석</h2>
              <CopyButton
                onClick={() => copyToClipboard(formatDetailedAnalysis(result.summary), "detail")}
                isCopied={copied === "detail"}
              />
            </div>

            <DetailItem label="통화 상대방" content={result.summary.participants} />
            <DetailItem label="핵심 내용" content={result.summary.keyPoints} />
            <DetailItem label="약속/합의 사항" content={result.summary.agreements} />
            <DetailItem
              label="법적 중요 발언"
              content={result.summary.legallySignificant}
              highlight
            />
            <DetailItem label="주의할 점" content={result.summary.cautions} />
          </div>

          <ResultSection
            title="전체 텍스트"
            content={result.transcript}
            onCopy={() => copyToClipboard(result.transcript, "transcript")}
            isCopied={copied === "transcript"}
          />

          {/* 전체 리포트 다운로드 */}
          <button
            onClick={downloadReport}
            className="w-full py-4 px-6 bg-green-600 text-white text-lg font-bold rounded-2xl active:bg-green-700"
          >
            전체 리포트 다운로드
          </button>
        </div>
      )}
    </main>
  );
}

function ResultSection({
  title,
  content,
  onCopy,
  isCopied,
}: {
  title: string;
  content: string;
  onCopy: () => void;
  isCopied: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">{title}</h2>
        <CopyButton onClick={onCopy} isCopied={isCopied} />
      </div>
      <p className="text-[15px] text-gray-700 whitespace-pre-wrap leading-loose">{content}</p>
    </div>
  );
}

function DetailItem({
  label,
  content,
  highlight,
}: {
  label: string;
  content: string;
  highlight?: boolean;
}) {
  return (
    <div className={`mb-3 p-3 rounded-xl ${highlight ? "bg-yellow-50 border border-yellow-200" : "bg-gray-50"}`}>
      <h3 className={`text-sm font-bold mb-1 ${highlight ? "text-yellow-800" : "text-gray-500"}`}>
        {label}
      </h3>
      <p className={`text-[15px] whitespace-pre-wrap leading-loose ${highlight ? "text-yellow-900" : "text-gray-700"}`}>
        {content}
      </p>
    </div>
  );
}

function CopyButton({ onClick, isCopied }: { onClick: () => void; isCopied: boolean }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-100 text-gray-600 active:bg-gray-200"
    >
      {isCopied ? "복사됨!" : "복사"}
    </button>
  );
}
