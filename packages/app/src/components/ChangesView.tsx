import "./ChangesView.css";

export function ChangesView() {
    return (
        <div className="changes-view">
            <div className="changes-list">
                <div className="panel-header">📝 变更文件</div>
                <div className="change-items">
                    <div className="change-item added">
                        <span className="change-badge">A</span>
                        <span>src/App.tsx</span>
                    </div>
                    <div className="change-item modified">
                        <span className="change-badge">M</span>
                        <span>src/main.tsx</span>
                    </div>
                    <div className="change-item deleted">
                        <span className="change-badge">D</span>
                        <span>src/old.ts</span>
                    </div>
                </div>
            </div>
            <div className="changes-diff">
                <div className="panel-header">Diff</div>
                <pre className="diff-content">
                    <code>{`// 选择左侧文件查看 diff`}</code>
                </pre>
            </div>
        </div>
    );
}
