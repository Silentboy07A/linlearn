export type RiskLevel = "Low" | "Medium" | "High";
export type Difficulty = "Beginner" | "Intermediate" | "Advanced";
export type Level = "Beginner" | "Intermediate" | "Advanced" | "Expert";

export type ModuleId =
  | "dashboard"
  | "terminal"
  | "command"
  | "script"
  | "chat"
  | "quiz"
  | "interview"
  | "error"
  | "cheatsheet"
  | "history"
  | "leaderboard"
  | "bookmarks"
  | "settings";

export interface Profile {
  id: string;
  username: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface Progress {
  id: string;
  user_id: string;
  xp: number;
  streak: number;
  level: Level;
  last_active: string;
}

export interface CommandResponse {
  command: string;
  explanation: string;
  risk: RiskLevel;
  output: string;
  warning: string;
}

export interface ScriptResponse {
  script: string;
  breakdown: string[];
  warning: string;
  difficulty: string;
}

export interface QuizQuestion {
  question: string;
  options: [string, string, string, string];
  correct: number;
  explanation: string;
}

export interface ErrorExplainResponse {
  summary: string;
  rootCause: string;
  steps: string[];
  prevention: string[];
  commands: string[];
}

export interface CheatSheetResponse {
  title: string;
  sections: {
    heading: string;
    items: { command: string; description: string }[];
  }[];
}

export interface InterviewStartResponse {
  question: string;
  questionNumber: number;
  totalQuestions: number;
}

export interface InterviewAnswerResponse {
  score: number;
  good: string;
  missing: string;
  modelAnswer: string;
  nextQuestion: string | null;
  questionNumber: number;
}

export interface InterviewReportResponse {
  totalScore: number;
  performance: string;
  strengths: string[];
  improvements: string[];
  recommendations: string[];
}

export interface CommandHistoryRow {
  id: string;
  query: string;
  command: string;
  explanation: string | null;
  risk_level: string | null;
  created_at: string;
}

export interface QuizResultRow {
  id: string;
  category: string;
  score: number;
  total: number;
  difficulty: string;
  created_at: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DashboardStats {
  xp: number;
  streak: number;
  level: Level;
  quizzesCompleted: number;
  commandsGenerated: number;
  scriptsGenerated: number;
  interviewsCompleted: number;
  cheatSheetsGenerated: number;
}
