"use client";

import { useState, useRef, useEffect } from "react";
import type { Summary, TranscribeResult } from "@/app/types";

type Result = TranscribeResult;

type ProcessingStep = "idle" | "processing" | "done" | "error";

const STORAGE_KEY = "voice-summary-result";

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
    if (step !== "processing") {
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
    setStep("processing");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMsg = "처리 중 오류가 발생했습니다.";
        try {
          const data = await response.json();
          errorMsg = data.error || errorMsg;
        } catch {
          if (response.status === 504) {
            errorMsg = "서버 처리 시간이 초과되었습니다. 파일이 너무 길 수 있습니다.";
          } else {
            errorMsg = `서버 오류 (${response.status}). 잠시 후 다시 시도해주세요.`;
          }
        }
        throw new Error(errorMsg);
      }

      const data: Result = await response.json();
      setResult(data);
      setStep("done");

      // localStorage에 결과 저장
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          result: data,
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

  const isProcessing = step === "processing";

  return (
    <main className="min-h-screen px-4 py-6 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-center mb-1">녹음 요약 도구</h1>
      <p className="text-sm text-gray-400 text-center mb-6">삼촌이 깨어나길 기도합니다</p>

      {/* 이전 결과 알림 */}
      {savedFileName && !isProcessing && (
        <div className="mb-4 p-3 bg-gray-50 rounded-2xl flex items-center justify-between">
          <p className="text-sm text-gray-600">이전 결과: {savedFileName}</p>
          <button
            onClick={clearSavedResult}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-200 text-gray-600 active:bg-gray-300"
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
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          className="w-full py-4 px-6 bg-white border-2 border-dashed border-gray-300 rounded-2xl text-lg font-medium text-gray-600 active:bg-gray-100 disabled:opacity-50"
        >
          {file ? `${file.name}` : "녹음 파일 선택"}
        </button>
        {file && (
          <p className="mt-2 text-sm text-gray-500 text-center">
            {(file.size / (1024 * 1024)).toFixed(1)}MB
          </p>
        )}
      </div>

      {/* 변환 버튼 */}
      <button
        onClick={handleSubmit}
        disabled={!file || isProcessing}
        className="w-full py-4 px-6 bg-blue-600 text-white text-lg font-bold rounded-2xl active:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 mb-6"
      >
        {isProcessing ? "처리 중..." : "변환 시작"}
      </button>

      {/* 진행 상태 */}
      {isProcessing && (
        <div className="mb-6 p-4 bg-blue-50 rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-blue-800 font-medium">
              처리 중... ({elapsedSeconds}초 경과)
            </span>
          </div>
          <p className="mt-2 text-sm text-blue-600">
            파일 크기에 따라 1~3분 정도 걸릴 수 있습니다.
          </p>
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
      <p className="text-gray-700 whitespace-pre-wrap leading-relaxed">{content}</p>
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
      <p className={`whitespace-pre-wrap leading-relaxed ${highlight ? "text-yellow-900" : "text-gray-700"}`}>
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
