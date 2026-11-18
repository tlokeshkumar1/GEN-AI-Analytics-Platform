import React, { useEffect, useState } from 'react';
import { agentActivityStore, AgentActivityRecord } from '../services/agentActivityStore';
import { AIAgentIngestionStepper } from './AIAgentIngestionStepper';

interface AgentActivityModalProps {
  onNavigateToDashboard?: () => void;
  onNavigateToBuildKpi?: () => void;
}

export const AgentActivityModal: React.FC<AgentActivityModalProps> = ({
  onNavigateToDashboard,
  onNavigateToBuildKpi,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activities, setActivities] = useState<AgentActivityRecord[]>(() => agentActivityStore.getActivities());
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);

  useEffect(() => {
    const unsubModal = agentActivityStore.subscribeModal((open, activityId) => {
      setIsOpen(open);
      const currentList = agentActivityStore.getActivities();
      setActivities([...currentList]);
      if (activityId) {
        setSelectedActivityId(activityId);
      } else if (currentList.length > 0) {
        setSelectedActivityId(prev => prev || currentList[0].id);
      }
    });

    const unsubStore = agentActivityStore.subscribe(() => {
      const currentList = agentActivityStore.getActivities();
      setActivities([...currentList]);
      if (currentList.length > 0) {
        setSelectedActivityId(prev => prev || currentList[0].id);
      }
    });

    return () => {
      unsubModal();
      unsubStore();
    };
  }, [selectedActivityId]);

  if (!isOpen) return null;

  const currentActivity = activities.find(a => a.id === selectedActivityId) || activities[0] || null;

  if (!currentActivity) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full border border-slate-200 text-center space-y-4">
          <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center mx-auto text-slate-500">
            <span className="material-symbols-outlined text-2xl">smart_toy</span>
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900">No Agent Activity Recorded Yet</h3>
            <p className="text-xs text-slate-500 mt-1">
              Upload an Excel or CSV file in Upload Files to trigger the Preprocessing, Domain Classification, and Recommendation agents.
            </p>
          </div>
          <button
            type="button"
            onClick={() => agentActivityStore.closeModal()}
            className="w-full py-2 bg-slate-900 hover:bg-black text-white text-xs font-bold rounded-lg transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <AIAgentIngestionStepper
      isOpen={isOpen}
      isProcessing={currentActivity.isProcessing}
      filename={currentActivity.filename}
      result={currentActivity.result}
      partialResult={currentActivity.partialResult}
      stageStatuses={currentActivity.stageStatuses}
      stageMessages={currentActivity.stageMessages}
      stageDurations={currentActivity.stageDurations}
      error={currentActivity.error}
      activities={activities}
      activeActivityId={currentActivity.id}
      onSelectActivity={id => {
        setSelectedActivityId(id);
        agentActivityStore.setActiveActivityId(id);
      }}
      onClose={() => agentActivityStore.closeModal()}
      onNavigateToDashboard={() => {
        agentActivityStore.closeModal();
        onNavigateToDashboard?.();
      }}
      onNavigateToBuildKpi={() => {
        agentActivityStore.closeModal();
        onNavigateToBuildKpi?.();
      }}
    />
  );
};
