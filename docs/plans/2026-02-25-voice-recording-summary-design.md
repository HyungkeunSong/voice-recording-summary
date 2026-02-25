# Voice Recording Summary - Design Document

## Purpose
산재 사고 관련 통화 녹음 파일을 업로드하면 텍스트 변환 + 요약을 제공하는 모바일 웹앱.
가족 여러 명이 각자 폰에서 URL로 접속하여 사용.

## Architecture
- Next.js 14 (App Router) + TypeScript + Tailwind CSS
- OpenAI Whisper API → 음성을 한국어 텍스트로 변환
- OpenAI GPT-5.2 → 간단 요약 + 구조화 분석 생성
- Vercel 배포, DB 없음, 인증 없음

## Flow
1. 파일 선택 버튼으로 녹음 파일 업로드 (m4a, mp3, aac, amr, wav, ogg, webm / 25MB 이하)
2. API Route에서 Whisper API 호출 → transcript
3. GPT-5.2로 요약 생성
4. 결과 표시: 간단 요약 + 구조화 분석 + 전체 텍스트 (각각 복사 버튼)

## UI
- 모바일 전용 단일 페이지
- 파일 선택 버튼 (드래그 앤 드롭 없음)
- 처리 중 진행 상태 표시
- 결과 섹션별 복사 버튼

## Output Structure
- 간단 요약 (3-5줄)
- 구조화 분석: 통화 상대방, 핵심 내용, 약속/합의 사항, 법적 중요 발언, 주의할 점
- 전체 텍스트 (transcript)
