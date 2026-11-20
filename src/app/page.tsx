"use client";

import Image from "next/image";
import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import AutomationPanel from "./automation-panel-multi";
import { appUrl } from "../app-path";
import { buildSignInUrl, DEFAULT_SIGN_METHOD, selectSignIdentifier, signMethodLabel } from "../sign-url.mjs";

type SignMethod = "timeTableId" | "courseSchedId";

type CourseItem = {
	id: string;
	uuid: string;
	courseName: string;
	teacherName: string;
	weekDay: string;
	classBeginTime: string;
	classEndTime: string;
	signStatus: string;
};

type QueryResponse = {
	date: string;
	total: number;
	courses: CourseItem[];
};

type DirectSignResponse = {
	success?: boolean;
	message?: string;
	upstreamStatus?: string;
	result?: {
		stuSignId?: string;
		stuSignStatus?: string;
	};
};

type StatusKind = "idle" | "loading" | "success" | "error" | "info";
type FeatureMode = "query" | "manual" | "automation";
const AUTO_QR_TTL_MS = 5 * 1000;
const DOWNLOAD_QR_TTL_MS = 10 * 1000;
const OFFSET_TTL_MS = 30 * 1000;
// UCAS 的 get_timestamp.do 与 stu_scan_sign.action 运行在不同服务器上，
// 两者时钟偏差约 3.5s。校准对齐了 timestamp API，需要减去缓冲才能被 sign API 接受。
const SIGN_TIMESTAMP_BUFFER_MS = 3 * 1000;

const ACTION_STATUS_DEFAULT_TEXT = "生成签到码后，可在此查看下载、复制和点击签到的状态信息";
type QrSource = { mode: "query" | "manual"; identifier: NonNullable<ReturnType<typeof selectSignIdentifier>> };

function getCourseKey(course: CourseItem): string {
	return `${course.id}-${course.uuid}`;
}

function toYyyyMMdd(dateInput: string): string {
	return dateInput.replace(/-/g, "");
}

function getTodayInputDate(): string {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatRange(start: string, end: string): string {
	const toTimeOnly = (value: string): string => {
		if (!value) {
			return "--";
		}

		const timeMatch = value.match(/(\d{2}:\d{2}(?::\d{2})?)$/);
		if (timeMatch) {
			return timeMatch[1];
		}

		return value;
	};

	if (!start && !end) {
		return "--";
	}
	return `${toTimeOnly(start)} ~ ${toTimeOnly(end)}`;
}

async function generateQrDataUrlFromPayload(payload: string): Promise<string> {
	const { default: QRCode } = await import("qrcode");
	return QRCode.toDataURL(payload, {
		width: 320,
		margin: 1,
		errorCorrectionLevel: "M"
	});
}

function extractClockTime(value: string): string | null {
	if (!value) {
		return null;
	}
	const timeMatch = value.match(/(\d{2}:\d{2}(?::\d{2})?)$/);
	if (!timeMatch) {
		return null;
	}
	return timeMatch[1].length === 5 ? `${timeMatch[1]}:00` : timeMatch[1];
}

function buildDateTimeFromClock(dateInput: string, clockTime: string | null): Date | null {
	if (!clockTime) {
		return null;
	}

	const parsed = new Date(`${dateInput}T${clockTime}`);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed;
}

export default function Home() {
	const [featureMode, setFeatureMode] = useState<FeatureMode>("query");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [date, setDate] = useState(getTodayInputDate);
	const [keyword, setKeyword] = useState("");
	const [manualIdentifier, setManualIdentifier] = useState("");
	const [courses, setCourses] = useState<CourseItem[]>([]);
	const [selectedCourseKey, setSelectedCourseKey] = useState("");
	const [defaultQuerySignMethod, setDefaultQuerySignMethod] = useState<SignMethod>(DEFAULT_SIGN_METHOD);
	const [courseSignMethods, setCourseSignMethods] = useState<Record<string, SignMethod>>({});
	const [statusText, setStatusText] = useState("输入学号、密码和日期，开始查询课程");
	const [statusKind, setStatusKind] = useState<StatusKind>("idle");
	const [actionStatusText, setActionStatusText] = useState(ACTION_STATUS_DEFAULT_TEXT);
	const [actionStatusKind, setActionStatusKind] = useState<StatusKind>("idle");
	const [loading, setLoading] = useState(false);
	const [manualLoading, setManualLoading] = useState(false);
	const [directSignLoading, setDirectSignLoading] = useState(false);
	const [signUrl, setSignUrl] = useState("");
	const [qrDataUrl, setQrDataUrl] = useState("");
	const [expireAt, setExpireAt] = useState(0);
	const [expireCountdown, setExpireCountdown] = useState(0);
	const [renderNow, setRenderNow] = useState(0);
	const [timeOffset, setTimeOffset] = useState(0);
	const [qrRelayActive, setQrRelayActive] = useState(false);
	const [qrSource, setQrSource] = useState<QrSource | null>(null);
	const qrSectionRef = useRef<HTMLDivElement | null>(null);

	const updateStatus = (kind: StatusKind, message: string) => {
		setStatusKind(kind);
		setStatusText(message);
	};

	const updateActionStatus = (kind: StatusKind, message: string) => {
		setActionStatusKind(kind);
		setActionStatusText(message);
	};

	const timeOffsetRef = useRef<{ offset: number; fetchedAt: number } | null>(null);

	const getServerTimeOffset = useCallback(async (): Promise<number> => {
		const cached = timeOffsetRef.current;
		if (cached && Date.now() - cached.fetchedAt < OFFSET_TTL_MS) {
			return cached.offset;
		}

		try {
			const start = Date.now();
			const res = await fetch(appUrl("/api/course-uuid/timestamp"), {
				cache: "no-store"
			});
			if (!res.ok) {
				throw new Error();
			}
			const data = await res.json();
			if (data.success && typeof data.timestamp === "number") {
				const latency = Math.max(0, Date.now() - start);
				const serverTime = data.timestamp + Math.floor(latency / 2);
				const offset = serverTime - Date.now();
				timeOffsetRef.current = { offset, fetchedAt: Date.now() };
				setTimeOffset(offset);
				return offset;
			}
		} catch {}

		// 校准失败：优先用过期的缓存降级
		if (cached) return cached.offset;
		timeOffsetRef.current = { offset: 0, fetchedAt: Date.now() };
		setTimeOffset(0);
		return 0;
	}, []);

	useEffect(() => {
		const timer = window.setTimeout(() => void getServerTimeOffset(), 0);
		return () => window.clearTimeout(timer);
	}, [getServerTimeOffset]);

	useEffect(() => {
		const initialTimer = window.setTimeout(() => setRenderNow(Date.now()), 0);
		const timer = window.setInterval(() => setRenderNow(Date.now()), 1_000);
		return () => {
			window.clearTimeout(initialTimer);
			window.clearInterval(timer);
		};
	}, []);

	const resetGeneratedSignState = () => {
		setSelectedCourseKey("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setExpireCountdown(0);
		setQrRelayActive(false);
		setQrSource(null);
		setActionStatusKind("idle");
		setActionStatusText(ACTION_STATUS_DEFAULT_TEXT);
	};

	const regenerateAutoQr = useCallback(async (source: QrSource): Promise<boolean> => {
		const offset = await getServerTimeOffset();
		const currentTimestamp = Date.now() + offset;
		// 签到时间戳减去缓冲，弥补 UCAS 两台服务器间的时钟偏差
		const signTimestamp = currentTimestamp - SIGN_TIMESTAMP_BUFFER_MS;
		const payload = buildSignInUrl(source.identifier, signTimestamp);
		if (!payload) {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			setSignUrl(payload);
			setExpireAt(currentTimestamp + AUTO_QR_TTL_MS);
			setQrDataUrl(imageUrl);
			return true;
		} catch {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}
	}, [getServerTimeOffset]);

	const getStatusBannerClassName = (kind: StatusKind): string => {
		if (kind === "error") {
			return "status-banner--error";
		}
		if (kind === "success") {
			return "status-banner--success";
		}
		if (kind === "info") {
			return "status-banner--info";
		}
		if (kind === "loading") {
			return "status-banner--loading";
		}
		return "status-banner--neutral";
	};

	useEffect(() => {
		if (!expireAt) {
			return;
		}

		const updateCountdown = () => {
			const remainMs = expireAt - (Date.now() + (timeOffsetRef.current?.offset ?? 0));
			setExpireCountdown(Math.max(0, Math.ceil(remainMs / 1000)));
		};

		updateCountdown();
		const timer = window.setInterval(updateCountdown, 250);

		return () => {
			window.clearInterval(timer);
		};
	}, [expireAt]);

	useEffect(() => {
		if (!qrSource || !expireAt) {
			return;
		}

		const delay = Math.max(0, expireAt - (Date.now() + (timeOffsetRef.current?.offset ?? 0)));
		const timer = window.setTimeout(async () => {
			const ok = await regenerateAutoQr(qrSource);
			if (!ok) {
				if (qrSource.mode === "query") {
					updateActionStatus("error", "签到码自动刷新失败，请重新选择课程");
				} else {
					updateStatus("error", "签到码自动刷新失败，请重新生成");
				}
			}
		}, delay);

		return () => {
			window.clearTimeout(timer);
		};
	}, [qrSource, expireAt, regenerateAutoQr]);

	const deferredKeyword = useDeferredValue(keyword);

	const filteredCourses = useMemo(() => {
		const word = deferredKeyword.trim().toLowerCase();
		if (!word) {
			return courses;
		}
		return courses.filter((item) => {
			return item.courseName.toLowerCase().includes(word) || item.teacherName.toLowerCase().includes(word);
		});
	}, [courses, deferredKeyword]);

	const hasCourses = courses.length > 0;
	const hasQr = Boolean(qrDataUrl);
	const queryAttempted = statusKind !== "idle";
	const hasKeyword = keyword.trim().length > 0;
	const emptyHelpText = hasKeyword ? "可先清空筛选词，再查看全部课程" : "检查日期是否为上课日，并确认学号与密码正确";
	const isCourseSelected = (course: CourseItem): boolean => selectedCourseKey === getCourseKey(course);
	const getCourseSignMethod = (course: CourseItem): SignMethod =>
		courseSignMethods[getCourseKey(course)] ?? defaultQuerySignMethod;

	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setLoading(true);
		setSelectedCourseKey("");
		setCourseSignMethods({});
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setExpireCountdown(0);
		setQrSource(null);
		updateStatus("loading", "正在查询课程…");

		try {
			const res = await fetch(appUrl("/api/course-uuid/query"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					username: username.trim(),
					password,
					date: toYyyyMMdd(date)
				})
			});

			const data = (await res.json()) as QueryResponse & { message?: string };

			if (!res.ok) {
				setCourses([]);
				updateStatus("error", data.message ?? "查询失败，请重试");
				return;
			}

			setCourses(data.courses ?? []);
			updateStatus("success", `已查询到 ${data.total} 门课程（${data.date}）`);
		} catch {
			setCourses([]);
			updateStatus("error", "网络异常，请稍后重试");
		} finally {
			setLoading(false);
		}
	};

	const onPick = async (course: CourseItem, preferredMethodOverride?: SignMethod) => {
		const preferredMethod = preferredMethodOverride ?? getCourseSignMethod(course);
		const identifier = selectSignIdentifier(course.uuid, course.id, preferredMethod);
		if (!identifier) return;
		resetGeneratedSignState();
		setSelectedCourseKey(getCourseKey(course));
		const source: QrSource = { mode: "query", identifier };
		setQrSource(source);

		const ok = await regenerateAutoQr(source);
		if (!ok) {
			updateActionStatus("error", "签到码生成失败，请重新选择课程");
			return;
		}

		const fallbackNote = identifier.name !== preferredMethod
			? `（缺少对应编号，已自动回退${signMethodLabel(identifier.name)}）`
			: "";
		updateActionStatus("success", `已按${signMethodLabel(identifier.name)}生成签到码${fallbackNote}（5秒后自动刷新）`);

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
			updateActionStatus("info", `已生成${signMethodLabel(identifier.name)}签到码${fallbackNote}`);
		}
	};

	const onChangeAllQuerySignMethod = async (nextMethod: SignMethod) => {
		setDefaultQuerySignMethod(nextMethod);
		setCourseSignMethods({});
		if (selectedCourse) {
			await onPick(selectedCourse, nextMethod);
		}
	};

	const onChangeCourseSignMethod = async (course: CourseItem, nextMethod: SignMethod) => {
		const key = getCourseKey(course);
		setCourseSignMethods((current) => ({ ...current, [key]: nextMethod }));
		if (selectedCourseKey === key) {
			await onPick(course, nextMethod);
		}
	};

	const onManualGenerate = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const identifier = selectSignIdentifier(manualIdentifier, manualIdentifier);
		if (!identifier) {
			updateStatus("error", "请输入 32 位课程 UUID 或 7 位课程 ID");
			return;
		}
		const source: QrSource = { mode: "manual", identifier };

		setManualLoading(true);
		setSelectedCourseKey("");
		setQrSource(source);

		let ok = false;
		try {
			ok = await regenerateAutoQr(source);
		} finally {
			setManualLoading(false);
		}

		if (!ok) {
			updateStatus("error", "签到码生成失败，请检查课程 UUID 或 ID 后重试");
			return;
		}

		updateStatus("success", "签到码已生成（5秒后自动刷新）");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	};

	const onDownloadQr = async () => {
		if (!qrSource) {
			return;
		}

		const offset = await getServerTimeOffset();
		const deadline = Date.now() + offset + DOWNLOAD_QR_TTL_MS;
		const payload = buildSignInUrl(qrSource.identifier, deadline);
		if (!payload) {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请重新生成签到码");
				return;
			}
			updateStatus("error", "下载二维码失败，请重新生成签到码");
			return;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			const link = document.createElement("a");
			link.href = imageUrl;
			link.download = `ucas-signin-${qrSource.identifier.value}-${deadline}.png`;
			link.click();
			if (featureMode === "query") {
				updateActionStatus("success", "二维码已开始下载（10秒有效）");
				return;
			}
			updateStatus("success", "二维码已开始下载（10秒有效）");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请稍后重试");
				return;
			}
			updateStatus("error", "下载二维码失败，请稍后重试");
		}
	};

	const onCopySignUrl = async () => {
		if (!signUrl) {
			return;
		}

		try {
			await navigator.clipboard.writeText(signUrl);
			if (featureMode === "query") {
				updateActionStatus("info", "已复制签到链接");
				return;
			}
			updateStatus("info", "已复制签到链接");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "复制签到链接失败，请手动复制");
				return;
			}
			updateStatus("error", "复制签到链接失败，请手动复制");
		}
	};

	const refreshCoursesAfterSign = async (): Promise<{ ok: true; total: number } | { ok: false }> => {
		try {
			const res = await fetch(appUrl("/api/course-uuid/query"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					username: username.trim(),
					password,
					date: toYyyyMMdd(date)
				})
			});

			const data = (await res.json()) as QueryResponse & { message?: string };
			if (!res.ok) {
				return { ok: false };
			}

			setCourses(data.courses ?? []);
			return { ok: true, total: data.total ?? (data.courses ?? []).length };
		} catch {
			return { ok: false };
		}
	};

	const onDirectSign = async () => {
		if (directSignBlockedByTime) {
			updateActionStatus("error", "当前不在签到时间（开课前30分钟至下课前可签到）");
			return;
		}

		const preferredMethod = selectedCourse ? getCourseSignMethod(selectedCourse) : defaultQuerySignMethod;
		const identifier = selectSignIdentifier(selectedCourse?.uuid, selectedCourse?.id, preferredMethod);
		if (!identifier) {
			updateActionStatus("error", "请先在查询课程模式选择课程并生成签到码");
			return;
		}

		const safeUsername = username.trim();
		if (!safeUsername || !password) {
			updateActionStatus("error", "请先输入学号和密码");
			return;
		}

		setDirectSignLoading(true);
		updateActionStatus("loading", "正在发起签到…");

		try {
			// 优先复用当前课程二维码的时间戳。
			let signTimestamp = 0;
			try {
				const url = new URL(signUrl);
				const ts = url.searchParams.get("timestamp");
				if (ts && url.searchParams.get(identifier.name) === identifier.value) signTimestamp = Number(ts);
			} catch {}
			// 降级：使用校准后的当前时间戳（减去缓冲）
			if (!signTimestamp || !Number.isFinite(signTimestamp)) {
				const offset = await getServerTimeOffset();
				signTimestamp = renderNow + offset - SIGN_TIMESTAMP_BUFFER_MS;
			}

			const res = await fetch(appUrl("/api/course-uuid/sign"), {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					username: safeUsername,
					password,
					[identifier.name]: identifier.value,
					timestamp: signTimestamp
				})
			});

			const data = (await res.json()) as DirectSignResponse;

			if (!res.ok || !data.success) {
				updateActionStatus("error", data.message ?? "签到失败，请稍后重试");
				return;
			}

			const signIdText = data.result?.stuSignId ? `（签到记录 ${data.result.stuSignId}）` : "";
			const refreshed = await refreshCoursesAfterSign();
			if (refreshed.ok) {
				updateActionStatus("success", `${data.message ?? "签到成功"}${signIdText}，课程状态已刷新`);
			} else {
				updateActionStatus(
					"info",
					`${data.message ?? "签到成功"}${signIdText}，但课程状态刷新失败，请手动查询`
				);
			}
		} catch {
			updateActionStatus("error", "网络异常，签到请求未完成");
		} finally {
			setDirectSignLoading(false);
		}
	};

	const selectedCourse = selectedCourseKey ? courses.find((item) => getCourseKey(item) === selectedCourseKey) ?? null : null;

	const now = renderNow + timeOffset;

	const signWindow = (() => {
		if (!selectedCourse) {
			return null;
		}

		const classBegin = buildDateTimeFromClock(date, extractClockTime(selectedCourse.classBeginTime));
		const classEnd = buildDateTimeFromClock(date, extractClockTime(selectedCourse.classEndTime));
		if (!classBegin || !classEnd) {
			return null;
		}

		const openAt = new Date(classBegin.getTime() - 30 * 60 * 1000);
		return {
			openAt: openAt.getTime(),
			closeAt: classEnd.getTime()
		};
	})();

	const directSignBlockedByTime = Boolean(
		selectedCourse && (!signWindow || now < signWindow.openAt || now > signWindow.closeAt)
	);

	const directSignDisabled = loading || directSignLoading || !hasQr || !selectedCourseKey || directSignBlockedByTime;

	const directSignButtonText = directSignLoading
		? "签到中..."
		: directSignBlockedByTime
			? "不在签到时间"
			: "点击签到";

	return (
		<>
			<div className="grain flex min-h-screen flex-col px-4 py-6 sm:px-8 sm:py-9">
				<main className="mx-auto w-full max-w-6xl">
					<header className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
						<div>
							<a href="#main-content" className="sr-only focus:not-sr-only skip-link">
								跳到主要内容
							</a>
							<div className="flex items-center gap-3.5">
								<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--line)] bg-white shadow-xs">
									<Image src={appUrl("/ucas.svg")} alt="UCAS" width={30} height={30} unoptimized />
								</div>
								<div>
									<p className="text-[11px] font-semibold tracking-[0.18em] text-[color:var(--accent)] uppercase">
										Course &amp; Auto Sign-In
									</p>
									<h1 className="text-2xl font-bold tracking-tight text-[color:var(--ink)] sm:text-3xl">
										UCAS Course
									</h1>
								</div>
							</div>
							<p className="mt-3 max-w-2xl text-sm leading-6 text-[color:var(--muted)]">
								实时查询课程、切换打卡机扫码 / 课堂扫码生成动态二维码或直接签到，并支持多账号后台每日自动签到与 QQ 控制。
							</p>
						</div>

						<nav aria-label="功能模式切换" className="segmented-nav self-start lg:self-end">
							<button
								type="button"
								onClick={() => {
									resetGeneratedSignState();
									setFeatureMode("query");
									updateStatus("idle", "输入学号、密码和日期，开始查询课程");
								}}
								className={`segmented-tab ${featureMode === "query" ? "segmented-tab--active" : ""}`}
							>
								查询课程
							</button>
							<button
								type="button"
								onClick={() => {
									resetGeneratedSignState();
									setFeatureMode("manual");
									updateStatus("idle", "输入课程 UUID 或 ID，直接生成签到码");
								}}
								className={`segmented-tab ${featureMode === "manual" ? "segmented-tab--active" : ""}`}
							>
								手动生成
							</button>
							<button
								type="button"
								onClick={() => setFeatureMode("automation")}
								className={`segmented-tab ${featureMode === "automation" ? "segmented-tab--active" : ""}`}
							>
								自动签到
							</button>
						</nav>
					</header>

					{featureMode === "query" ? (
						<section
							id="main-content"
							className="grid items-start gap-6 xl:grid-cols-[minmax(320px,360px)_minmax(0,1fr)]"
						>
							<form onSubmit={onSubmit} className="panel rounded-3xl p-6">
								<div className="space-y-1">
									<h2 className="text-xl font-bold tracking-tight text-[color:var(--ink)]">查询课程</h2>
									<p className="text-xs text-[color:var(--green)]">
										学号和密码仅用于本次查询，不会保存
									</p>
								</div>

								<div className="mt-5 space-y-4">
									<label className="block text-sm font-semibold text-[color:var(--ink-soft)]">
										学号
										<input
											className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3.5 py-2.5 text-sm"
											name="studentId"
											value={username}
											onChange={(e) => setUsername(e.target.value)}
											placeholder="请输入学号"
											autoComplete="username"
											spellCheck={false}
											required
										/>
									</label>

									<label className="block text-sm font-semibold text-[color:var(--ink-soft)]">
										密码
										<input
											type="password"
											className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3.5 py-2.5 text-sm"
											name="password"
											value={password}
											onChange={(e) => setPassword(e.target.value)}
											placeholder="请输入课程系统密码"
											autoComplete="current-password"
											required
										/>
									</label>

									<label className="block text-sm font-semibold text-[color:var(--ink-soft)]">
										日期
										<input
											type="date"
											className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3.5 py-2.5 text-sm"
											name="courseDate"
											value={date}
											onChange={(e) => setDate(e.target.value)}
											required
										/>
									</label>

									<button
										disabled={loading}
										className="action-btn action-btn--primary min-h-11 w-full rounded-xl px-4 py-2.5 text-sm font-semibold"
										type="submit"
									>
										{loading ? "查询中..." : "查询课程"}
									</button>
								</div>

								<p
									role="status"
									aria-live={statusKind === "error" ? "assertive" : "polite"}
									aria-atomic="true"
									className={`status-banner mt-4 rounded-xl px-3.5 py-2.5 text-xs leading-5 ${getStatusBannerClassName(statusKind)}`}
								>
									{statusText}
								</p>
							</form>

							<div className="panel rounded-3xl p-6">
								<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
									<div>
										<h2 className="text-xl font-bold tracking-tight text-[color:var(--ink)]">课程列表与签到码</h2>
										<p className="mt-0.5 text-xs text-[color:var(--muted)]">
											签到码每 5 秒自动刷新，下载的二维码约 10 秒有效
										</p>
									</div>
									<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
										<label className="flex items-center gap-2 text-xs font-semibold text-[color:var(--muted)]">
											<span className="shrink-0">全部方式</span>
											<select
												aria-label="全部课程签到方式"
												value={defaultQuerySignMethod}
												onChange={(e) => void onChangeAllQuerySignMethod(e.target.value as SignMethod)}
												className="focus-ring input-surface min-h-10 rounded-xl border px-3 py-1.5 text-xs font-semibold text-[color:var(--ink)]"
											>
												<option value="timeTableId">打卡机扫码（32位 UUID）</option>
												<option value="courseSchedId">课堂扫码（7位课程号）</option>
											</select>
										</label>
										{hasCourses ? (
											<input
												className="focus-ring input-surface min-h-10 w-full rounded-xl border px-3.5 py-1.5 text-xs sm:w-48"
												name="courseFilter"
												aria-label="筛选课程"
												value={keyword}
												onChange={(e) => setKeyword(e.target.value)}
												placeholder="筛选课程名或教师"
											/>
										) : null}
									</div>
								</div>

								<div className="mt-5 space-y-5">
									<div className="space-y-3 lg:hidden">
										{filteredCourses.length === 0 ? (
											<div className="sub-card px-4 py-10 text-center text-sm text-[color:var(--muted)]">
												<p className="font-medium text-[color:var(--ink-soft)]">暂无课程数据</p>
												{queryAttempted ? (
													<p className="mt-1.5 text-xs leading-5 text-[color:var(--muted)]">
														{emptyHelpText}
													</p>
												) : null}
											</div>
										) : (
											filteredCourses.map((course) => {
												const selected = isCourseSelected(course);
												const courseMethod = getCourseSignMethod(course);
												const resolvedIdentifier = selectSignIdentifier(course.uuid, course.id, courseMethod);
												const canGenerate = Boolean(resolvedIdentifier);
												return (
													<article
														key={getCourseKey(course)}
														className={`clay-card rounded-2xl p-4 ${selected ? "course-item--selected" : ""}`}
													>
														<div className="flex items-start justify-between gap-3">
															<h3 className="text-sm font-semibold leading-6 text-[color:var(--ink)] break-words">
																{course.courseName || "--"}
															</h3>
															<span
																className={`status-chip rounded-full border px-2.5 py-0.5 text-[11px] ${
																	course.signStatus === "1"
																		? "status-chip--signed"
																		: "status-chip--unsigned"
																}`}
															>
																{course.signStatus === "1" ? "已签到" : "未签到"}
															</span>
														</div>
														<dl className="mt-2.5 grid grid-cols-[44px_1fr] items-center gap-x-2 gap-y-1.5 text-xs text-[color:var(--muted)]">
															<dt className="font-medium">教师</dt>
															<dd className="text-[color:var(--ink-soft)] break-words">
																{course.teacherName || "--"}
															</dd>
															<dt className="font-medium">时段</dt>
															<dd className="numeric-tabular text-[color:var(--ink-soft)] break-words">
																{formatRange(
																	course.classBeginTime,
																	course.classEndTime
																)}
															</dd>
															<dt className="font-medium">方式</dt>
															<dd className="flex flex-wrap items-center gap-2">
																<select
																	aria-label={`${course.courseName || "课程"}签到方式`}
																	value={courseMethod}
																	onChange={(e) => void onChangeCourseSignMethod(course, e.target.value as SignMethod)}
																	className="focus-ring input-surface rounded-lg border px-2.5 py-1 text-xs font-medium text-[color:var(--ink)]"
																>
																	<option value="timeTableId">打卡机扫码</option>
																	<option value="courseSchedId">课堂扫码</option>
																</select>
																{resolvedIdentifier && resolvedIdentifier.name !== courseMethod ? (
																	<span className="text-[11px] text-[color:var(--muted)]">
																		缺号，回退{signMethodLabel(resolvedIdentifier.name)}
																	</span>
																) : null}
															</dd>
														</dl>
														<button
															type="button"
															disabled={!canGenerate}
															onClick={() => onPick(course)}
															className={`action-btn mt-3.5 min-h-10 w-full rounded-xl px-3.5 py-2 text-xs font-semibold ${
																selected ? "action-btn--primary" : "action-btn--secondary"
															}`}
														>
															{!canGenerate ? "缺少有效编号" : selected ? "当前已选中" : "生成签到码"}
														</button>
													</article>
												);
											})
										)}
									</div>

									<div className="render-skip hidden overflow-hidden rounded-2xl border border-[color:var(--line)] bg-white lg:block">
										<table className="min-w-full text-sm">
											<caption className="sr-only">课程查询结果和签到码生成操作</caption>
											<thead className="border-b border-[color:var(--line)] bg-[color:var(--surface-subtle)] text-left text-xs font-semibold text-[color:var(--muted)]">
												<tr>
													<th className="px-4 py-3">课程</th>
													<th className="px-3 py-3">教师</th>
													<th className="px-3 py-3">时段</th>
													<th className="px-3 py-3">签到方式</th>
													<th className="px-3 py-3">状态</th>
													<th className="px-4 py-3 text-right">操作</th>
												</tr>
											</thead>
											<tbody className="divide-y divide-[color:var(--line)]">
												{filteredCourses.length === 0 ? (
													<tr>
														<td colSpan={6} className="px-4 py-10 text-center text-sm text-[color:var(--muted)]">
															<p className="font-medium text-[color:var(--ink-soft)]">暂无课程数据</p>
															{queryAttempted ? (
																<p className="mt-1.5 text-xs leading-5 text-[color:var(--muted)]">
																	{emptyHelpText}
																</p>
															) : null}
														</td>
													</tr>
												) : (
													filteredCourses.map((course) => {
														const selected = isCourseSelected(course);
														const courseMethod = getCourseSignMethod(course);
														const resolvedIdentifier = selectSignIdentifier(course.uuid, course.id, courseMethod);
														const canGenerate = Boolean(resolvedIdentifier);
														return (
															<tr
																key={getCourseKey(course)}
																className={`course-row ${selected ? "bg-[#f4f8ff]" : "bg-white"}`}
															>
																<td className="max-w-[180px] px-4 py-3.5 font-semibold text-[color:var(--ink)] break-words">
																	{course.courseName || "--"}
																</td>
																<td className="px-3 py-3.5 text-xs text-[color:var(--ink-soft)]">
																	{course.teacherName || "--"}
																</td>
																<td className="numeric-tabular max-w-[160px] px-3 py-3.5 text-xs text-[color:var(--ink-soft)] break-words">
																	{formatRange(
																		course.classBeginTime,
																		course.classEndTime
																	)}
																</td>
																<td className="px-3 py-3.5">
																	<select
																		aria-label={`${course.courseName || "课程"}签到方式`}
																		value={courseMethod}
																		onChange={(e) => void onChangeCourseSignMethod(course, e.target.value as SignMethod)}
																		className="focus-ring input-surface rounded-lg border px-2.5 py-1.5 text-xs font-medium text-[color:var(--ink)]"
																	>
																		<option value="timeTableId">打卡机扫码</option>
																		<option value="courseSchedId">课堂扫码</option>
																	</select>
																	{resolvedIdentifier && resolvedIdentifier.name !== courseMethod ? (
																		<p className="mt-1 text-[11px] text-[color:var(--muted)]">
																			缺号，回退{signMethodLabel(resolvedIdentifier.name)}
																		</p>
																	) : null}
																</td>
																<td className="px-3 py-3.5">
																	<span
																		className={`status-chip rounded-full border px-2.5 py-0.5 text-[11px] ${
																			course.signStatus === "1"
																				? "status-chip--signed"
																				: "status-chip--unsigned"
																		}`}
																	>
																		{course.signStatus === "1" ? "已签到" : "未签到"}
																	</span>
																</td>
																<td className="px-4 py-3.5 text-right">
																	<button
																		type="button"
																		disabled={!canGenerate}
																		onClick={() => onPick(course)}
																		className={`action-btn min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold ${
																			selected ? "action-btn--primary" : "action-btn--secondary"
																		}`}
																	>
																		{!canGenerate ? "缺少编号" : selected ? "已选中" : "生成签到码"}
																	</button>
																</td>
															</tr>
														);
													})
												)}
											</tbody>
										</table>
									</div>

									<div
										ref={qrSectionRef}
										className={`render-skip sub-card p-5 ${qrRelayActive ? "relay-highlight" : ""}`}
									>
										{hasQr ? (
											<div className="grid gap-5 lg:grid-cols-[204px_1fr] lg:items-center">
												<div className="mx-auto rounded-2xl border border-[color:var(--line)] bg-white p-3 shadow-xs lg:mx-0">
													<Image
														src={qrDataUrl}
														alt="签到码"
														width={180}
														height={180}
														unoptimized
														className="h-[180px] w-[180px] rounded-lg"
													/>
												</div>
												<div className="space-y-3.5 text-sm numeric-tabular">
													<div className="flex flex-wrap items-center gap-2">
														<span className="pill-tag pill-tag--blue">
															{qrSource ? signMethodLabel(qrSource.identifier.name) : "--"}
														</span>
														<span className="pill-tag">
															刷新倒计时 {expireCountdown}s
														</span>
													</div>
													<p className="rounded-xl border border-[color:var(--line)] bg-white px-3 py-2 font-mono text-[11px] leading-5 text-[color:var(--muted)] break-all">
														{signUrl}
													</p>
													<div className="flex flex-wrap gap-2">
														<button
															type="button"
															onClick={onDirectSign}
															disabled={directSignDisabled}
															className="action-btn action-btn--primary min-h-10 rounded-xl px-4 py-2 text-xs font-semibold"
														>
															{directSignButtonText}
														</button>
														<button
															type="button"
															onClick={onDownloadQr}
															className="action-btn action-btn--secondary min-h-10 rounded-xl px-4 py-2 text-xs font-semibold"
														>
															下载二维码
														</button>
														<button
															type="button"
															onClick={onCopySignUrl}
															className="action-btn action-btn--quiet min-h-10 rounded-xl px-4 py-2 text-xs font-semibold"
														>
															复制链接
														</button>
													</div>
													<p
														role="status"
														aria-live={actionStatusKind === "error" ? "assertive" : "polite"}
														aria-atomic="true"
														className={`status-banner rounded-xl px-3.5 py-2 text-xs leading-5 ${getStatusBannerClassName(actionStatusKind)}`}
													>
														{actionStatusText}
													</p>
												</div>
											</div>
										) : (
											<div className="py-6 text-center">
												<p className="text-sm font-medium text-[color:var(--ink-soft)]">尚未生成签到码</p>
												<p className="mt-1 text-xs text-[color:var(--muted)]">
													查询课程后点击“生成签到码”，此处将展示实时刷新的二维码与一键签到按钮
												</p>
											</div>
										)}
									</div>
								</div>
							</div>
						</section>
					) : featureMode === "manual" ? (
						<section
							id="main-content"
							className="grid items-start gap-6 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]"
						>
							<form onSubmit={onManualGenerate} className="panel rounded-3xl p-6">
								<div className="space-y-1">
									<h2 className="text-xl font-bold tracking-tight text-[color:var(--ink)]">手动生成签到码</h2>
									<p className="text-xs leading-5 text-[color:var(--muted)]">
										32 位 UUID 对应打卡机扫码（可带连字符），7 位课程号对应课堂扫码
									</p>
								</div>

								<div className="mt-5 space-y-4">
									<label className="block text-sm font-semibold text-[color:var(--ink-soft)]">
										课程 UUID / 7 位课程号
										<input
											className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3.5 py-2.5 font-mono text-xs"
											name="manualCourseIdentifier"
											value={manualIdentifier}
											onChange={(e) => setManualIdentifier(e.target.value)}
											placeholder="00112233-4455-6677-8899-aabbccddeeff 或 1234567"
											autoComplete="off"
											spellCheck={false}
											required
										/>
									</label>

									<button
										disabled={manualLoading}
										className="action-btn action-btn--primary min-h-11 w-full rounded-xl px-4 py-2.5 text-sm font-semibold"
										type="submit"
									>
										{manualLoading ? "生成中..." : "生成签到码"}
									</button>
								</div>

								<p
									role="status"
									aria-live={statusKind === "error" ? "assertive" : "polite"}
									aria-atomic="true"
									className={`status-banner mt-4 rounded-xl px-3.5 py-2.5 text-xs leading-5 ${getStatusBannerClassName(statusKind)}`}
								>
									{statusText}
								</p>
							</form>

							<div
								ref={qrSectionRef}
								className={`render-skip panel rounded-3xl p-6 ${qrRelayActive ? "relay-highlight" : ""}`}
							>
								{hasQr ? (
									<div className="grid gap-5 lg:grid-cols-[204px_1fr] lg:items-center">
										<div className="mx-auto rounded-2xl border border-[color:var(--line)] bg-white p-3 shadow-xs lg:mx-0">
											<Image
												src={qrDataUrl}
												alt="签到码"
												width={180}
												height={180}
												unoptimized
												className="h-[180px] w-[180px] rounded-lg"
											/>
										</div>
										<div className="space-y-3.5 text-sm numeric-tabular">
											<div className="flex flex-wrap items-center gap-2">
												<span className="pill-tag pill-tag--blue">
													{qrSource ? signMethodLabel(qrSource.identifier.name) : "--"}
												</span>
												<span className="pill-tag">
													刷新倒计时 {expireCountdown}s
												</span>
											</div>
											<p className="rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-subtle)] px-3 py-2 font-mono text-[11px] leading-5 text-[color:var(--muted)] break-all">
												{signUrl}
											</p>
											<div className="flex flex-wrap gap-2">
												<button
													type="button"
													onClick={onDownloadQr}
													className="action-btn action-btn--secondary min-h-10 rounded-xl px-4 py-2 text-xs font-semibold"
												>
													下载二维码
												</button>
												<button
													type="button"
													onClick={onCopySignUrl}
													className="action-btn action-btn--quiet min-h-10 rounded-xl px-4 py-2 text-xs font-semibold"
												>
													复制链接
												</button>
											</div>
										</div>
									</div>
								) : (
									<div className="py-12 text-center">
										<p className="text-sm font-medium text-[color:var(--ink-soft)]">暂无签到码数据</p>
										<p className="mt-1 text-xs text-[color:var(--muted)]">
											在左侧输入 32 位 UUID 或 7 位课程号即可实时生成动态签到码
										</p>
									</div>
								)}
							</div>
						</section>
					) : (
						<AutomationPanel />
					)}
				</main>
			</div>
		</>
	);
}
