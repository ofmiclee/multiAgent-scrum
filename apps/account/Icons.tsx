import type {SVGProps} from 'react';

// Project-owned geometric SVG primitives; no external icon assets or fonts.
type Props=SVGProps<SVGSVGElement>&{size?:number};
const icon=(path:string)=>function Icon({size=20,...props}:Props){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...props}><path d={path}/></svg>;};
export const ArrowLeft=icon('M20 12H4m6-6-6 6 6 6');
export const ArrowRight=icon('M4 12h16m-6-6 6 6-6 6');
export const Check=icon('m5 12 4 4L19 6');
export const Plus=icon('M12 4v16M4 12h16');
export const X=icon('m5 5 14 14M19 5 5 19');
export const Building2=icon('M5 21V3h14v18M9 7h1m4 0h1M9 11h1m4 0h1m-5 9v-5h4v5');
export const Cpu=icon('M6 6h12v12H6zM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4');
export const Layers3=icon('m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4');
export const LoaderCircle=icon('M21 12a9 9 0 1 1-9-9');
export const LogOut=icon('M10 4H4v16h6m-1-8h12m-5-5 5 5-5 5');
export const Mail=icon('M3 5h18v14H3zM3 6l9 7 9-7');
export const ShieldCheck=icon('m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 11l3 3 5-5');
export const UserRound=icon('M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0M4 22v-3a8 6 0 0 1 16 0v3');
export const UsersRound=icon('M7 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0M3 21v-3a7 5 0 0 1 14 0v3m0-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2');
export const UserPlus=icon('M5 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0M2 21v-3a6 5 0 0 1 12 0v3m5-15v8m-4-4h8');
export const FileText=icon('M5 3h10l4 4v14H5zM9 11h6m-6 5h6');
export const BookOpen=icon('M12 5C9 3 5 3 2 4v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1zm0 0v16');
export const Clock3=icon('M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v6h5');
export const Folder=icon('M3 5h7l2 3h9v13H3z');
export const LayoutDashboard=icon('M3 3h7v8H3zm11 0h7v5h-7zM3 15h7v6H3zm11-3h7v9h-7z');
export const RefreshCw=icon('M21 7v5h-5m5 0a9 9 0 1 0-3 7');
