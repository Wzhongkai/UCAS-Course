import type { Metadata, Viewport } from "next";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
	title: "UCAS Course",
	description: "查询 UCAS 课程、生成实时签到码，并可在网页中管理每日自动签到。",
	icons: {
		icon: `${basePath}/ucas.svg`,
		shortcut: `${basePath}/ucas.svg`,
		apple: `${basePath}/ucas.svg`,
	},
};

export const viewport: Viewport = {
	themeColor: "#f1f5fb",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="zh-CN" className="h-full antialiased">
			<body className="min-h-full flex flex-col">
				{children}
			</body>
		</html>
	);
}
