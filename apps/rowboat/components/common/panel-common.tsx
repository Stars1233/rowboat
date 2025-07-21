import clsx from "clsx";
import { Sparkles } from "lucide-react";
import { SHOW_COPILOT_MARQUEE } from "@/app/lib/feature_flags";
import Image from "next/image";
import mascot from "@/public/mascot.png";

export function ActionButton({
    icon = null,
    children,
    onClick = undefined,
    disabled = false,
    primary = false,
}: {
    icon?: React.ReactNode;
    children: React.ReactNode;
    onClick?: () => void | undefined;
    disabled?: boolean;
    primary?: boolean;
}) {
    const onClickProp = onClick ? { onClick } : {};
    return <button
        disabled={disabled}
        className={clsx("rounded-md text-xs flex items-center gap-1 disabled:text-gray-300 dark:disabled:text-gray-600 hover:text-gray-600 dark:hover:text-gray-300", {
            "text-blue-600 dark:text-blue-400": primary,
            "text-gray-400 dark:text-gray-500": !primary,
        })}
        {...onClickProp}
    >
        {icon}
        {children}
    </button>;
}

interface PanelProps {
    title: React.ReactNode;
    rightActions?: React.ReactNode;
    actions?: React.ReactNode;
    children: React.ReactNode;
    maxHeight?: string;
    variant?: 'default' | 'copilot' | 'playground' | 'projects' | 'entity-list';
    showWelcome?: boolean;
    className?: string;
    onClick?: () => void;
    tourTarget?: string;
    overflow?: 'hidden' | 'visible' | 'auto' | 'scroll' | undefined;
}

export function Panel({
    title,
    rightActions,
    actions,
    children,
    maxHeight,
    variant = 'default',
    showWelcome = true,
    className,
    onClick,
    tourTarget,
    overflow,
}: PanelProps) {
    const isEntityList = variant === 'entity-list';
    
    return <div 
        className={clsx(
            "flex flex-col rounded-xl border relative w-full",
            // Only apply overflow-hidden if no custom overflow is set (for backward compatibility)
            overflow ? undefined : "overflow-hidden",
            variant === 'copilot' ? "border-blue-200 dark:border-blue-800" : "border-zinc-200 dark:border-zinc-800",
            "bg-white dark:bg-zinc-900",
            maxHeight ? "max-h-(--panel-height)" : "h-full",
            className
        )}
        style={{ 
            '--panel-height': maxHeight,
            ...(overflow ? { overflow } : {})
        } as React.CSSProperties}
        onClick={onClick}
        data-tour-target={tourTarget}
    >
        {variant === 'copilot' && showWelcome && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none -mt-16">
                {/* Replace Sparkles icon with mascot image */}
                <Image src={mascot} alt="Rowboat Mascot" width={192} height={192} className="object-contain mb-2 animate-float" />
                {SHOW_COPILOT_MARQUEE && (
                    <div className="relative mt-8 max-w-full px-8">
                        <div className="font-mono text-sm whitespace-nowrap text-blue-400/60 dark:text-blue-500/40 font-small inline-flex">
                            <div className="overflow-hidden w-0 animate-typing">What can I help you build?</div>
                            <div className="border-r-2 border-blue-400 dark:border-blue-500 animate-cursor">&nbsp;</div>
                        </div>
                    </div>
                )}
            </div>
        )}
        <div 
            className={clsx(
                "shrink-0 border-b border-zinc-100 dark:border-zinc-800 relative",
                {
                    "flex flex-col gap-3 px-4 py-3": variant === 'projects',
                    "flex items-center justify-between h-[53px] p-3": isEntityList,
                    "flex items-center justify-between px-6 py-3": !isEntityList && variant !== 'projects'
                }
            )}
        >
            {variant === 'projects' ? (
                <>
                    <div className="text-sm uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        {title}
                    </div>
                    {actions && <div className="flex items-center gap-2">
                        {actions}
                    </div>}
                </>
            ) : variant === 'copilot' ? (
                <>
                    <div className="flex items-center gap-2">
                        {title}
                    </div>
                    {rightActions}
                </>
            ) : isEntityList ? (
                <div className="flex items-center justify-between w-full">
                    {title}
                    {actions && <div className="flex items-center gap-2">
                        {actions}
                    </div>}
                </div>
            ) : (
                <>
                    {title}
                    {rightActions}
                </>
            )}
        </div>
        <div className={clsx(
            "min-h-0 flex-1 overflow-y-auto",
            (variant === 'projects' || isEntityList) && "custom-scrollbar"
        )}>
            {(variant === 'projects' || isEntityList) ? (
                <div className="px-4 py-3">
                    {children}
                </div>
            ) : children}
        </div>
    </div>;
}