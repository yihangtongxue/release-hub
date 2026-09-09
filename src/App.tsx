function App() {
  return (
    <div>
      <h1>Hello Electron + React</h1>

      <p>我的第一个 React Electron 桌面应用</p>

      <button
        onClick={() => {
          alert('Hello Electron!');
        }}
      >
        点击我
      </button>
    </div>
  );
}

export default App;
