import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import {takeLifecycleLink} from './lifecycle-link';
import {TooltipProvider} from './ui/tooltip';
import './styles.css';
import './workspace.css';
import './workspace-refinement.css';
import './workspace-navigation.css';

// Consume secrets before React effects or any asynchronous session/API work.
const githubFailed=window.location.hash==='#github-login=failed';
if(githubFailed)window.history.replaceState(null,'',window.location.pathname+window.location.search);
const initialLink = takeLifecycleLink(window.location, window.history);
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><TooltipProvider><App initialLink={initialLink} githubFailed={githubFailed} /></TooltipProvider></React.StrictMode>,
);
