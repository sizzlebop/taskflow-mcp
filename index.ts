#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

const DEFAULT_PATH = path.join(os.homedir(), "Documents", "tasks.json");
const TASK_FILE_PATH = process.env.TASK_MANAGER_FILE_PATH || DEFAULT_PATH;

interface Dependency {
  name: string;
  version?: string;
  url?: string;
  description?: string;
}

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface Subtask {
  id: string;
  title: string;
  description: string;
  done: boolean;
}

interface Task {
  id: string;
  title: string;
  description: string;
  done: boolean;
  approved: boolean;
  completedDetails: string;
  subtasks: Subtask[];
  dependencies?: Dependency[];
}

interface RequestEntry {
  requestId: string;
  originalRequest: string;
  splitDetails: string;
  tasks: Task[];
  completed: boolean; // marked true after all tasks done and request completion approved
  dependencies?: Dependency[];
  notes?: Note[];
}

interface TaskFlowFile {
  requests: RequestEntry[];
}

// Zod Schemas
const DependencySchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
});

const NoteSchema = z.object({
  title: z.string(),
  content: z.string(),
});

const SubtaskSchema = z.object({
  title: z.string(),
  description: z.string(),
});

const RequestPlanningSchema = z.object({
  originalRequest: z.string(),
  splitDetails: z.string().optional(),
  outputPath: z.string().optional(),
  dependencies: z.array(DependencySchema).optional(),
  notes: z.array(NoteSchema).optional(),
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      subtasks: z.array(SubtaskSchema).optional(),
      dependencies: z.array(DependencySchema).optional(),
    })
  ),
});

const GetNextTaskSchema = z.object({
  requestId: z.string(),
});

const MarkTaskDoneSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  completedDetails: z.string().optional(),
});

const ApproveTaskCompletionSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
});

const ApproveRequestCompletionSchema = z.object({
  requestId: z.string(),
});

const OpenTaskDetailsSchema = z.object({
  taskId: z.string(),
});

const ListRequestsSchema = z.object({});

const AddTasksToRequestSchema = z.object({
  requestId: z.string(),
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      subtasks: z.array(SubtaskSchema).optional(),
      dependencies: z.array(DependencySchema).optional(),
    })
  ),
});

const UpdateTaskSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const DeleteTaskSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
});

const AddSubtasksSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  subtasks: z.array(SubtaskSchema),
});

const MarkSubtaskDoneSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  subtaskId: z.string(),
});

const UpdateSubtaskSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  subtaskId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const DeleteSubtaskSchema = z.object({
  requestId: z.string(),
  taskId: z.string(),
  subtaskId: z.string(),
});

const ExportTaskStatusSchema = z.object({
  requestId: z.string(),
  outputPath: z.string(),
  format: z.enum(["markdown", "json", "html"]).default("markdown"),
});

const AddNoteSchema = z.object({
  requestId: z.string(),
  title: z.string(),
  content: z.string(),
});

const UpdateNoteSchema = z.object({
  requestId: z.string(),
  noteId: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
});

const DeleteNoteSchema = z.object({
  requestId: z.string(),
  noteId: z.string(),
});

const AddDependencySchema = z.object({
  requestId: z.string(),
  taskId: z.string().optional(), // If not provided, add to request
  dependency: DependencySchema,
});

// Tools

const PLAN_TASK_TOOL: Tool = {
  name: "plan_task",
  description:
    "Register a new user request and plan its associated tasks. You must provide 'originalRequest' and 'tasks', and optionally 'splitDetails'.\n\n" +
    "Tasks can now include subtasks, which are smaller units of work that make up a task. All subtasks must be completed before a task can be marked as done.\n\n" +
    "You can also include:\n" +
    "- 'dependencies': List of project or task-specific dependencies (libraries, tools, etc.)\n" +
    "- 'notes': General notes about the project (preferences, guidelines, etc.)\n" +
    "- 'outputPath': Path to save a Markdown file with the task plan for reference. It's recommended to use absolute paths (e.g., 'C:/Users/username/Documents/task-plan.md') rather than relative paths for more reliable file creation.\n\n" +
    "This tool initiates a new workflow for handling a user's request. The workflow is as follows:\n" +
    "1. Use 'plan_task' to register a request and its tasks (with optional subtasks, dependencies, and notes).\n" +
    "2. After adding tasks, you MUST use 'get_next_task' to retrieve the first task. A progress table will be displayed.\n" +
    "3. Use 'get_next_task' to retrieve the next uncompleted task.\n" +
    "4. If the task has subtasks, complete each subtask using 'mark_subtask_done' before marking the task as done.\n" +
    "5. **IMPORTANT:** After marking a task as done, a progress table will be displayed showing the updated status of all tasks. The assistant MUST NOT proceed to another task without the user's approval. The user must explicitly approve the completed task.\n" +
    "6. Once a task is approved, you can proceed to 'get_next_task' again to fetch the next pending task.\n" +
    "7. Repeat this cycle until all tasks are done.\n" +
    "8. After all tasks are completed (and approved), 'get_next_task' will indicate that all tasks are done and that the request awaits approval for full completion.\n" +
    "9. The user must then approve the entire request's completion. If the user does not approve and wants more tasks, you can again use 'plan_task' to add new tasks and continue the cycle.\n\n" +
    "The critical point is to always wait for user approval after completing each task and after all tasks are done, wait for request completion approval. Do not proceed automatically.",
  inputSchema: {
    type: "object",
    properties: {
      originalRequest: { type: "string" },
      splitDetails: { type: "string" },
      outputPath: { type: "string" },
      dependencies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            url: { type: "string" },
            description: { type: "string" },
          },
          required: ["name"],
        },
      },
      notes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "content"],
        },
      },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            dependencies: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  version: { type: "string" },
                  url: { type: "string" },
                  description: { type: "string" },
                },
                required: ["name"],
              },
            },
            subtasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                },
                required: ["title", "description"],
              },
            },
          },
          required: ["title", "description"],
        },
      },
    },
    required: ["originalRequest", "tasks"],
  },
};

const GET_NEXT_TASK_TOOL: Tool = {
  name: "get_next_task",
  description:
    "Given a 'requestId', return the next pending task (not done yet). If all tasks are completed, it will indicate that no more tasks are left and that you must ask the user what to do next.\n\n" +
    "A progress table showing the current status of all tasks will be displayed with each response.\n\n" +
    "If the same task is returned again or if no new task is provided after a task was marked as done, you MUST NOT proceed. In such a scenario, you must prompt the user for approval before calling 'get_next_task' again. Do not skip the user's approval step.\n" +
    "In other words:\n" +
    "- After calling 'mark_task_done', do not call 'get_next_task' again until 'approve_task_completion' is called by the user.\n" +
    "- If 'get_next_task' returns 'all_tasks_done', it means all tasks have been completed. At this point, confirm with the user that all tasks have been completed, and optionally add more tasks via 'plan_task'.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
    },
    required: ["requestId"],
  },
};

const MARK_TASK_DONE_TOOL: Tool = {
  name: "mark_task_done",
  description:
    "Mark a given task as done after you've completed it. Provide 'requestId' and 'taskId', and optionally 'completedDetails'.\n\n" +
    "After marking a task as done, a progress table will be displayed showing the updated status of all tasks.\n\n" +
    "After this, DO NOT proceed to 'get_next_task' again until the user has explicitly approved this completed task using 'approve_task_completion'.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
      completedDetails: { type: "string" },
    },
    required: ["requestId", "taskId"],
  },
};

const OPEN_TASK_DETAILS_TOOL: Tool = {
  name: "open_task_details",
  description:
    "Get details of a specific task by 'taskId'. This is for inspecting task information at any point.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
    },
    required: ["taskId"],
  },
};

const LIST_REQUESTS_TOOL: Tool = {
  name: "list_requests",
  description:
    "List all requests with their basic information and summary of tasks. This provides a quick overview of all requests in the system.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const ADD_TASKS_TO_REQUEST_TOOL: Tool = {
  name: "add_tasks_to_request",
  description:
    "Add new tasks to an existing request. This allows extending a request with additional tasks.\n\n" +
    "Tasks can include subtasks and dependencies. A progress table will be displayed showing all tasks including the newly added ones.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            dependencies: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  version: { type: "string" },
                  url: { type: "string" },
                  description: { type: "string" },
                },
                required: ["name"],
              },
            },
            subtasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                },
                required: ["title", "description"],
              },
            },
          },
          required: ["title", "description"],
        },
      },
    },
    required: ["requestId", "tasks"],
  },
};

const UPDATE_TASK_TOOL: Tool = {
  name: "update_task",
  description:
    "Update an existing task's title and/or description. Only uncompleted tasks can be updated.\n\n" +
    "A progress table will be displayed showing the updated task information.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
    },
    required: ["requestId", "taskId"],
  },
};

const DELETE_TASK_TOOL: Tool = {
  name: "delete_task",
  description:
    "Delete a specific task from a request. Only uncompleted tasks can be deleted.\n\n" +
    "A progress table will be displayed showing the remaining tasks after deletion.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
    },
    required: ["requestId", "taskId"],
  },
};

const ADD_SUBTASKS_TOOL: Tool = {
  name: "add_subtasks",
  description:
    "Add subtasks to an existing task. Provide 'requestId', 'taskId', and 'subtasks' array.\n\n" +
    "Subtasks are smaller units of work that make up a task. All subtasks must be completed before a task can be marked as done.\n\n" +
    "A progress table will be displayed showing the updated task with its subtasks.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
      subtasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
          },
          required: ["title", "description"],
        },
      },
    },
    required: ["requestId", "taskId", "subtasks"],
  },
};

const MARK_SUBTASK_DONE_TOOL: Tool = {
  name: "mark_subtask_done",
  description:
    "Mark a subtask as done. Provide 'requestId', 'taskId', and 'subtaskId'.\n\n" +
    "A progress table will be displayed showing the updated status of all tasks and subtasks.\n\n" +
    "All subtasks must be completed before a task can be marked as done.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
      subtaskId: { type: "string" },
    },
    required: ["requestId", "taskId", "subtaskId"],
  },
};

const UPDATE_SUBTASK_TOOL: Tool = {
  name: "update_subtask",
  description:
    "Update a subtask's title or description. Provide 'requestId', 'taskId', 'subtaskId', and optionally 'title' and/or 'description'.\n\n" +
    "Only uncompleted subtasks can be updated.\n\n" +
    "A progress table will be displayed showing the updated task with its subtasks.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
      subtaskId: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
    },
    required: ["requestId", "taskId", "subtaskId"],
  },
};

const DELETE_SUBTASK_TOOL: Tool = {
  name: "delete_subtask",
  description:
    "Delete a subtask from a task. Provide 'requestId', 'taskId', and 'subtaskId'.\n\n" +
    "Only uncompleted subtasks can be deleted.\n\n" +
    "A progress table will be displayed showing the updated task with its remaining subtasks.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
      subtaskId: { type: "string" },
    },
    required: ["requestId", "taskId", "subtaskId"],
  },
};

const EXPORT_TASK_STATUS_TOOL: Tool = {
  name: "export_task_status",
  description:
    "Export the current status of all tasks in a request to a file.\n\n" +
    "This tool allows you to save the current state of tasks, subtasks, dependencies, and notes to a file for reference.\n\n" +
    "You can specify the output format as 'markdown', 'json', or 'html'.\n\n" +
    "It's recommended to use absolute paths (e.g., 'C:/Users/username/Documents/task-status.md') rather than relative paths for more reliable file creation.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      outputPath: { type: "string" },
      format: {
        type: "string",
        enum: ["markdown", "json", "html"],
        default: "markdown"
      },
    },
    required: ["requestId", "outputPath"],
  },
};

const ADD_NOTE_TOOL: Tool = {
  name: "add_note",
  description:
    "Add a note to a request. Notes can contain important information about the project, such as user preferences or guidelines.\n\n" +
    "Notes are displayed in the task progress table and can be referenced when working on tasks.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      title: { type: "string" },
      content: { type: "string" },
    },
    required: ["requestId", "title", "content"],
  },
};

const UPDATE_NOTE_TOOL: Tool = {
  name: "update_note",
  description:
    "Update an existing note's title or content.\n\n" +
    "Provide the 'requestId' and 'noteId', and optionally 'title' and/or 'content' to update.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      noteId: { type: "string" },
      title: { type: "string" },
      content: { type: "string" },
    },
    required: ["requestId", "noteId"],
  },
};

const DELETE_NOTE_TOOL: Tool = {
  name: "delete_note",
  description:
    "Delete a note from a request.\n\n" +
    "Provide the 'requestId' and 'noteId' of the note to delete.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      noteId: { type: "string" },
    },
    required: ["requestId", "noteId"],
  },
};

const ADD_DEPENDENCY_TOOL: Tool = {
  name: "add_dependency",
  description:
    "Add a dependency to a request or task.\n\n" +
    "Dependencies can be libraries, tools, or other requirements needed for the project or specific tasks.\n\n" +
    "If 'taskId' is provided, the dependency will be added to that specific task. Otherwise, it will be added to the request.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string" },
      taskId: { type: "string" },
      dependency: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "string" },
          url: { type: "string" },
          description: { type: "string" },
        },
        required: ["name"],
      },
    },
    required: ["requestId", "dependency"],
  },
};

class TaskFlowServer {
  private requestCounter = 0;
  private taskCounter = 0;
  private data: TaskFlowFile = { requests: [] };

  constructor() {
    this.loadTasks();
  }

  private async loadTasks() {
    try {
      const data = await fs.readFile(TASK_FILE_PATH, "utf-8");
      this.data = JSON.parse(data);
      const allTaskIds: number[] = [];
      const allRequestIds: number[] = [];

      for (const req of this.data.requests) {
        const reqNum = Number.parseInt(req.requestId.replace("req-", ""), 10);
        if (!Number.isNaN(reqNum)) {
          allRequestIds.push(reqNum);
        }
        for (const t of req.tasks) {
          const tNum = Number.parseInt(t.id.replace("task-", ""), 10);
          if (!Number.isNaN(tNum)) {
            allTaskIds.push(tNum);
          }
        }
      }

      this.requestCounter =
        allRequestIds.length > 0 ? Math.max(...allRequestIds) : 0;
      this.taskCounter = allTaskIds.length > 0 ? Math.max(...allTaskIds) : 0;
    } catch (error) {
      this.data = { requests: [] };
    }
  }

  private async saveTasks() {
    try {
      await fs.writeFile(
        TASK_FILE_PATH,
        JSON.stringify(this.data, null, 2),
        "utf-8"
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("EROFS")) {
        console.error("EROFS: read-only file system. Cannot save tasks.");
        throw error;
      }
      throw error;
    }
  }

  private formatTaskProgressTable(requestId: string): string {
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return "Request not found";

    let table = "\nProgress Status:\n";
    table += "| Task ID | Title | Description | Status | Approval | Subtasks |\n";
    table += "|----------|----------|------|------|----------|----------|\n";

    for (const task of req.tasks) {
      const status = task.done ? "✅ Done" : "🔄 In Progress";
      const approved = task.approved ? "✅ Approved" : "⏳ Pending";
      const subtaskCount = task.subtasks.length;
      const completedSubtasks = task.subtasks.filter(s => s.done).length;
      const subtaskStatus = subtaskCount > 0
        ? `${completedSubtasks}/${subtaskCount}`
        : "None";

      table += `| ${task.id} | ${task.title} | ${task.description} | ${status} | ${approved} | ${subtaskStatus} |\n`;

      // Add subtasks with indentation if they exist
      if (subtaskCount > 0) {
        for (const subtask of task.subtasks) {
          const subtaskStatus = subtask.done ? "✅ Done" : "🔄 In Progress";
          table += `| └─ ${subtask.id} | ${subtask.title} | ${subtask.description} | ${subtaskStatus} | - | - |\n`;
        }
      }
    }

    return table;
  }

  /**
   * Export tasks to a Markdown file
   */
  public async exportTasksToMarkdown(requestId: string, outputPath: string): Promise<void> {
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) throw new Error("Request not found");

    let markdown = `# Project Plan: ${req.originalRequest}\n\n`;

    // Add split details if available
    if (req.splitDetails && req.splitDetails !== req.originalRequest) {
      markdown += `## Details\n${req.splitDetails}\n\n`;
    }

    // Add dependencies if available
    if (req.dependencies && req.dependencies.length > 0) {
      markdown += "## Dependencies\n\n";
      for (const dep of req.dependencies) {
        markdown += `- **${dep.name}**`;
        if (dep.version) markdown += ` (${dep.version})`;
        if (dep.description) markdown += `: ${dep.description}`;
        if (dep.url) markdown += ` - [Link](${dep.url})`;
        markdown += "\n";
      }
      markdown += "\n";
    }

    // Add notes if available
    if (req.notes && req.notes.length > 0) {
      markdown += "## Notes\n\n";
      for (const note of req.notes) {
        markdown += `### ${note.title}\n${note.content}\n\n`;
      }
    }

    // Add tasks overview with checkboxes
    markdown += "## Tasks Overview\n";
    for (const task of req.tasks) {
      markdown += `- [ ] ${task.title}\n`;

      // Add subtasks with indentation
      if (task.subtasks.length > 0) {
        for (const subtask of task.subtasks) {
          markdown += `  - [ ] ${subtask.title}\n`;
        }
      }

      // Add task dependencies if available
      if (task.dependencies && task.dependencies.length > 0) {
        markdown += `  - Dependencies: `;
        markdown += task.dependencies.map(d => d.name + (d.version ? ` (${d.version})` : "")).join(", ");
        markdown += "\n";
      }
    }
    markdown += "\n";

    // Add detailed tasks
    markdown += "## Detailed Tasks\n\n";
    for (let i = 0; i < req.tasks.length; i++) {
      const task = req.tasks[i];
      markdown += `### ${i + 1}. ${task.title}\n`;
      markdown += `**Description:** ${task.description}\n\n`;

      // Add task dependencies if available
      if (task.dependencies && task.dependencies.length > 0) {
        markdown += "**Dependencies:**\n";
        for (const dep of task.dependencies) {
          markdown += `- ${dep.name}`;
          if (dep.version) markdown += ` (${dep.version})`;
          if (dep.description) markdown += `: ${dep.description}`;
          if (dep.url) markdown += ` - [Link](${dep.url})`;
          markdown += "\n";
        }
        markdown += "\n";
      }

      // Add subtasks if available
      if (task.subtasks.length > 0) {
        markdown += "**Subtasks:**\n";
        for (const subtask of task.subtasks) {
          markdown += `- [ ] ${subtask.title}\n`;
          markdown += `  - Description: ${subtask.description}\n`;
        }
        markdown += "\n";
      }
    }

    // Add progress tracking section
    markdown += "## Progress Tracking\n\n";
    markdown += "| Task | Status | Completion Date |\n";
    markdown += "|------|--------|----------------|\n";
    for (const task of req.tasks) {
      markdown += `| ${task.title} | ${task.done ? "✅ Done" : "🔄 In Progress"} | ${task.done ? "YYYY-MM-DD" : ""} |\n`;
    }

    // Write to file
    try {
      await fs.writeFile(outputPath, markdown, "utf-8");
    } catch (error: unknown) {
      console.error(`Error writing to file ${outputPath}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write to file: ${errorMessage}`);
    }
  }

  /**
   * Export task status to a file in the specified format
   */
  public async exportTaskStatus(requestId: string, outputPath: string, format: "markdown" | "json" | "html" = "markdown"): Promise<void> {
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) throw new Error("Request not found");

    let content = "";

    switch (format) {
      case "markdown":
        content = await this.generateMarkdownStatus(req);
        break;
      case "json":
        content = JSON.stringify(req, null, 2);
        break;
      case "html":
        content = await this.generateHtmlStatus(req);
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    try {
      await fs.writeFile(outputPath, content, "utf-8");
    } catch (error: unknown) {
      console.error(`Error writing to file ${outputPath}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write to file: ${errorMessage}`);
    }

    return;
  }

  /**
   * Generate Markdown status report
   */
  private async generateMarkdownStatus(req: RequestEntry): Promise<string> {
    const now = new Date().toISOString().split("T")[0];
    let markdown = `# Task Status Report: ${req.originalRequest}\n\n`;
    markdown += `*Generated on: ${now}*\n\n`;

    // Overall progress
    const totalTasks = req.tasks.length;
    const completedTasks = req.tasks.filter(t => t.done).length;
    const approvedTasks = req.tasks.filter(t => t.approved).length;
    const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    markdown += `## Overall Progress: ${progressPercent}%\n\n`;
    markdown += `- **Total Tasks:** ${totalTasks}\n`;
    markdown += `- **Completed Tasks:** ${completedTasks}\n`;
    markdown += `- **Approved Tasks:** ${approvedTasks}\n`;
    markdown += `- **Remaining Tasks:** ${totalTasks - completedTasks}\n\n`;

    // Add notes if available
    if (req.notes && req.notes.length > 0) {
      markdown += "## Notes\n\n";
      for (const note of req.notes) {
        markdown += `### ${note.title}\n${note.content}\n\n`;
        markdown += `*Last updated: ${new Date(note.updatedAt).toLocaleString()}*\n\n`;
      }
    }

    // Task status
    markdown += "## Task Status\n\n";
    for (let i = 0; i < req.tasks.length; i++) {
      const task = req.tasks[i];
      const taskStatus = task.done ? "✅ Done" : "🔄 In Progress";
      const approvalStatus = task.approved ? "✅ Approved" : task.done ? "⏳ Pending Approval" : "⏳ Not Ready";

      markdown += `### ${i + 1}. ${task.title} (${taskStatus})\n`;
      markdown += `**Description:** ${task.description}\n\n`;
      markdown += `**Status:** ${taskStatus}\n`;
      markdown += `**Approval:** ${approvalStatus}\n`;

      if (task.done && task.completedDetails) {
        markdown += `**Completion Details:** ${task.completedDetails}\n\n`;
      }

      // Add subtasks if available
      if (task.subtasks.length > 0) {
        const totalSubtasks = task.subtasks.length;
        const completedSubtasks = task.subtasks.filter(s => s.done).length;
        const subtaskProgress = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

        markdown += `**Subtask Progress:** ${subtaskProgress}% (${completedSubtasks}/${totalSubtasks})\n\n`;
        markdown += "| Subtask | Description | Status |\n";
        markdown += "|---------|-------------|--------|\n";

        for (const subtask of task.subtasks) {
          const subtaskStatus = subtask.done ? "✅ Done" : "🔄 In Progress";
          markdown += `| ${subtask.title} | ${subtask.description} | ${subtaskStatus} |\n`;
        }
        markdown += "\n";
      }

      // Add dependencies if available
      if (task.dependencies && task.dependencies.length > 0) {
        markdown += "**Dependencies:**\n";
        for (const dep of task.dependencies) {
          markdown += `- ${dep.name}`;
          if (dep.version) markdown += ` (${dep.version})`;
          if (dep.description) markdown += `: ${dep.description}`;
          markdown += "\n";
        }
        markdown += "\n";
      }
    }

    return markdown;
  }

  /**
   * Generate HTML status report
   */
  private async generateHtmlStatus(req: RequestEntry): Promise<string> {
    const now = new Date().toISOString().split("T")[0];
    const totalTasks = req.tasks.length;
    const completedTasks = req.tasks.filter(t => t.done).length;
    const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Task Status: ${req.originalRequest}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 1000px; margin: 0 auto; padding: 20px; }
    h1, h2, h3 { color: #333; }
    .progress-bar { background-color: #f0f0f0; border-radius: 4px; height: 20px; margin-bottom: 20px; }
    .progress-bar-fill { background-color: #4CAF50; height: 100%; border-radius: 4px; width: ${progressPercent}%; }
    .task { border: 1px solid #ddd; padding: 15px; margin-bottom: 15px; border-radius: 4px; }
    .task-header { display: flex; justify-content: space-between; align-items: center; }
    .task-status { padding: 5px 10px; border-radius: 4px; font-size: 14px; }
    .status-done { background-color: #E8F5E9; color: #2E7D32; }
    .status-progress { background-color: #E3F2FD; color: #1565C0; }
    .status-approved { background-color: #E8F5E9; color: #2E7D32; }
    .status-pending { background-color: #FFF8E1; color: #F57F17; }
    .subtasks { margin-top: 10px; }
    .subtask { padding: 8px; border-bottom: 1px solid #eee; }
    .subtask:last-child { border-bottom: none; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
    th { background-color: #f2f2f2; }
    .note { background-color: #FFF8E1; padding: 10px; border-left: 4px solid #FFC107; margin-bottom: 15px; }
  </style>
</head>
<body>
  <h1>Task Status: ${req.originalRequest}</h1>
  <p><em>Generated on: ${now}</em></p>

  <h2>Overall Progress: ${progressPercent}%</h2>
  <div class="progress-bar">
    <div class="progress-bar-fill"></div>
  </div>
  <p>
    <strong>Total Tasks:</strong> ${totalTasks} |
    <strong>Completed:</strong> ${completedTasks} |
    <strong>Remaining:</strong> ${totalTasks - completedTasks}
  </p>
`;

    // Add notes if available
    if (req.notes && req.notes.length > 0) {
      html += `<h2>Notes</h2>`;
      for (const note of req.notes) {
        html += `
  <div class="note">
    <h3>${note.title}</h3>
    <p>${note.content}</p>
    <p><small>Last updated: ${new Date(note.updatedAt).toLocaleString()}</small></p>
  </div>`;
      }
    }

    // Task status
    html += `<h2>Task Status</h2>`;

    for (let i = 0; i < req.tasks.length; i++) {
      const task = req.tasks[i];
      const taskStatusClass = task.done ? "status-done" : "status-progress";
      const approvalStatusClass = task.approved ? "status-approved" : "status-pending";
      const taskStatus = task.done ? "Done" : "In Progress";
      const approvalStatus = task.approved ? "Approved" : task.done ? "Pending Approval" : "Not Ready";

      html += `
  <div class="task">
    <div class="task-header">
      <h3>${i + 1}. ${task.title}</h3>
      <span class="task-status ${taskStatusClass}">${taskStatus}</span>
    </div>
    <p><strong>Description:</strong> ${task.description}</p>
    <p><strong>Approval:</strong> <span class="task-status ${approvalStatusClass}">${approvalStatus}</span></p>`;

      if (task.done && task.completedDetails) {
        html += `<p><strong>Completion Details:</strong> ${task.completedDetails}</p>`;
      }

      // Add subtasks if available
      if (task.subtasks.length > 0) {
        const totalSubtasks = task.subtasks.length;
        const completedSubtasks = task.subtasks.filter(s => s.done).length;
        const subtaskProgress = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

        html += `
    <p><strong>Subtask Progress:</strong> ${subtaskProgress}% (${completedSubtasks}/${totalSubtasks})</p>
    <table>
      <tr>
        <th>Subtask</th>
        <th>Description</th>
        <th>Status</th>
      </tr>`;

        for (const subtask of task.subtasks) {
          const subtaskStatus = subtask.done ? "Done" : "In Progress";
          const subtaskStatusClass = subtask.done ? "status-done" : "status-progress";

          html += `
      <tr>
        <td>${subtask.title}</td>
        <td>${subtask.description}</td>
        <td><span class="task-status ${subtaskStatusClass}">${subtaskStatus}</span></td>
      </tr>`;
        }

        html += `
    </table>`;
      }

      // Add dependencies if available
      if (task.dependencies && task.dependencies.length > 0) {
        html += `
    <p><strong>Dependencies:</strong></p>
    <ul>`;

        for (const dep of task.dependencies) {
          html += `
      <li>${dep.name}${dep.version ? ` (${dep.version})` : ""}${dep.description ? `: ${dep.description}` : ""}</li>`;
        }

        html += `
    </ul>`;
      }

      html += `
  </div>`;
    }

    html += `
</body>
</html>`;

    return html;
  }

  private formatRequestsList(): string {
    let output = "\nRequests List:\n";
    output +=
      "| Request ID | Original Request | Total Tasks | Completed | Approved |\n";
    output +=
      "|------------|------------------|-------------|-----------|----------|\n";

    for (const req of this.data.requests) {
      const totalTasks = req.tasks.length;
      const completedTasks = req.tasks.filter((t) => t.done).length;
      const approvedTasks = req.tasks.filter((t) => t.approved).length;
      output += `| ${req.requestId} | ${req.originalRequest.substring(0, 30)}${req.originalRequest.length > 30 ? "..." : ""} | ${totalTasks} | ${completedTasks} | ${approvedTasks} |\n`;
    }

    return output;
  }

  public async requestPlanning(
    originalRequest: string,
    tasks: {
      title: string;
      description: string;
      subtasks?: { title: string; description: string }[];
      dependencies?: Dependency[];
    }[],
    splitDetails?: string,
    outputPath?: string,
    dependencies?: Dependency[],
    notes?: { title: string; content: string }[]
  ) {
    await this.loadTasks();
    this.requestCounter += 1;
    const requestId = `req-${this.requestCounter}`;

    const newTasks: Task[] = [];
    for (const taskDef of tasks) {
      this.taskCounter += 1;

      // Process subtasks if they exist
      const subtasks: Subtask[] = [];
      if (taskDef.subtasks && taskDef.subtasks.length > 0) {
        for (const subtaskDef of taskDef.subtasks) {
          this.taskCounter += 1;
          subtasks.push({
            id: `subtask-${this.taskCounter}`,
            title: subtaskDef.title,
            description: subtaskDef.description,
            done: false,
          });
        }
      }

      newTasks.push({
        id: `task-${this.taskCounter}`,
        title: taskDef.title,
        description: taskDef.description,
        done: false,
        approved: false,
        completedDetails: "",
        subtasks: subtasks,
        dependencies: taskDef.dependencies,
      });
    }

    // Process notes if they exist
    const processedNotes: Note[] = [];
    if (notes && notes.length > 0) {
      for (const noteDef of notes) {
        const now = new Date().toISOString();
        processedNotes.push({
          id: `note-${this.taskCounter++}`,
          title: noteDef.title,
          content: noteDef.content,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    this.data.requests.push({
      requestId,
      originalRequest,
      splitDetails: splitDetails || originalRequest,
      tasks: newTasks,
      completed: false,
      dependencies: dependencies,
      notes: processedNotes,
    });

    await this.saveTasks();

    // Generate Markdown file if outputPath is provided
    if (outputPath) {
      await this.exportTasksToMarkdown(requestId, outputPath);
    }

    const progressTable = this.formatTaskProgressTable(requestId);

    return {
      status: "planned",
      requestId,
      totalTasks: newTasks.length,
      outputPath: outputPath ? outputPath : undefined,
      tasks: newTasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
      })),
      message: `Tasks have been successfully added. Please use 'get_next_task' to retrieve the first task.\n${progressTable}`,
    };
  }

  public async getNextTask(requestId: string) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) {
      return { status: "error", message: "Request not found" };
    }
    if (req.completed) {
      return {
        status: "already_completed",
        message: "Request already completed.",
      };
    }
    const nextTask = req.tasks.find((t) => !t.done);
    if (!nextTask) {
      // all tasks done?
      const allDone = req.tasks.every((t) => t.done);
      if (allDone && !req.completed) {
        const progressTable = this.formatTaskProgressTable(requestId);
        return {
          status: "all_tasks_done",
          message: `All tasks have been completed. Awaiting completion approval.\n${progressTable}`,
        };
      }
      return { status: "no_next_task", message: "No undone tasks found." };
    }

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "next_task",
      task: {
        id: nextTask.id,
        title: nextTask.title,
        description: nextTask.description,
      },
      message: `Next task is ready. Task approval will be required after completion.\n${progressTable}`,
    };
  }

  public async markTaskDone(
    requestId: string,
    taskId: string,
    completedDetails?: string
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };
    const task = req.tasks.find((t) => t.id === taskId);
    if (!task) return { status: "error", message: "Task not found" };
    if (task.done)
      return {
        status: "already_done",
        message: "Task is already marked done.",
      };

    // Check if all subtasks are done
    const hasSubtasks = task.subtasks.length > 0;
    const allSubtasksDone = task.subtasks.every(s => s.done);

    if (hasSubtasks && !allSubtasksDone) {
      return {
        status: "subtasks_pending",
        message: "Cannot mark task as done until all subtasks are completed.",
        pendingSubtasks: task.subtasks.filter(s => !s.done).map(s => ({
          id: s.id,
          title: s.title,
        })),
      };
    }

    task.done = true;
    task.completedDetails = completedDetails || "";
    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);

    return {
      status: "task_marked_done",
      requestId: req.requestId,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        completedDetails: task.completedDetails,
        approved: task.approved,
        subtasks: task.subtasks.map(s => ({
          id: s.id,
          title: s.title,
          description: s.description,
          done: s.done,
        })),
      },
      message: `Task ${taskId} has been marked as done.\n${progressTable}`,
    };
  }

  public async openTaskDetails(taskId: string) {
    await this.loadTasks();
    for (const req of this.data.requests) {
      const target = req.tasks.find((t) => t.id === taskId);
      if (target) {
        return {
          status: "task_details",
          requestId: req.requestId,
          originalRequest: req.originalRequest,
          splitDetails: req.splitDetails,
          completed: req.completed,
          task: {
            id: target.id,
            title: target.title,
            description: target.description,
            done: target.done,
            approved: target.approved,
            completedDetails: target.completedDetails,
            subtasks: target.subtasks.map(s => ({
              id: s.id,
              title: s.title,
              description: s.description,
              done: s.done,
            })),
          },
        };
      }

      // Check if it's a subtask ID
      for (const task of req.tasks) {
        const subtask = task.subtasks.find(s => s.id === taskId);
        if (subtask) {
          return {
            status: "subtask_details",
            requestId: req.requestId,
            taskId: task.id,
            subtask: {
              id: subtask.id,
              title: subtask.title,
              description: subtask.description,
              done: subtask.done,
            },
            parentTask: {
              id: task.id,
              title: task.title,
            },
          };
        }
      }
    }
    return { status: "task_not_found", message: "No such task or subtask found" };
  }

  public async listRequests() {
    await this.loadTasks();
    const requestsList = this.formatRequestsList();
    return {
      status: "requests_listed",
      message: `Current requests in the system:\n${requestsList}`,
      requests: this.data.requests.map((req) => ({
        requestId: req.requestId,
        originalRequest: req.originalRequest,
        totalTasks: req.tasks.length,
        completedTasks: req.tasks.filter((t) => t.done).length,
        approvedTasks: req.tasks.filter((t) => t.approved).length,
      })),
    };
  }

  public async addTasksToRequest(
    requestId: string,
    tasks: { title: string; description: string; subtasks?: { title: string; description: string }[] }[]
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };
    if (req.completed)
      return {
        status: "error",
        message: "Cannot add tasks to completed request",
      };

    const newTasks: Task[] = [];
    for (const taskDef of tasks) {
      this.taskCounter += 1;

      // Process subtasks if they exist
      const subtasks: Subtask[] = [];
      if (taskDef.subtasks && taskDef.subtasks.length > 0) {
        for (const subtaskDef of taskDef.subtasks) {
          this.taskCounter += 1;
          subtasks.push({
            id: `subtask-${this.taskCounter}`,
            title: subtaskDef.title,
            description: subtaskDef.description,
            done: false,
          });
        }
      }

      newTasks.push({
        id: `task-${this.taskCounter}`,
        title: taskDef.title,
        description: taskDef.description,
        done: false,
        approved: false,
        completedDetails: "",
        subtasks: subtasks,
      });
    }

    req.tasks.push(...newTasks);
    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "tasks_added",
      message: `Added ${newTasks.length} new tasks to request.\n${progressTable}`,
      newTasks: newTasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
      })),
    };
  }

  public async updateTask(
    requestId: string,
    taskId: string,
    updates: { title?: string; description?: string }
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    const task = req.tasks.find((t) => t.id === taskId);
    if (!task) return { status: "error", message: "Task not found" };
    if (task.done)
      return { status: "error", message: "Cannot update completed task" };

    if (updates.title) task.title = updates.title;
    if (updates.description) task.description = updates.description;

    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "task_updated",
      message: `Task ${taskId} has been updated.\n${progressTable}`,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
      },
    };
  }

  public async deleteTask(requestId: string, taskId: string) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    const taskIndex = req.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return { status: "error", message: "Task not found" };
    if (req.tasks[taskIndex].done)
      return { status: "error", message: "Cannot delete completed task" };

    req.tasks.splice(taskIndex, 1);
    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "task_deleted",
      message: `Task ${taskId} has been deleted.\n${progressTable}`,
    };
  }

  public async addSubtasks(
    requestId: string,
    taskId: string,
    subtasks: { title: string; description: string }[]
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    const task = req.tasks.find((t) => t.id === taskId);
    if (!task) return { status: "error", message: "Task not found" };
    if (task.done)
      return { status: "error", message: "Cannot add subtasks to completed task" };

    const newSubtasks: Subtask[] = [];
    for (const subtaskDef of subtasks) {
      this.taskCounter += 1;
      newSubtasks.push({
        id: `subtask-${this.taskCounter}`,
        title: subtaskDef.title,
        description: subtaskDef.description,
        done: false,
      });
    }

    task.subtasks.push(...newSubtasks);
    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "subtasks_added",
      message: `Added ${newSubtasks.length} new subtasks to task ${taskId}.\n${progressTable}`,
      newSubtasks: newSubtasks.map(s => ({
        id: s.id,
        title: s.title,
        description: s.description,
      })),
    };
  }

  public async markSubtaskDone(
    requestId: string,
    taskId: string,
    subtaskId: string
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    const task = req.tasks.find((t) => t.id === taskId);
    if (!task) return { status: "error", message: "Task not found" };

    const subtask = task.subtasks.find(s => s.id === subtaskId);
    if (!subtask) return { status: "error", message: "Subtask not found" };
    if (subtask.done)
      return { status: "already_done", message: "Subtask is already marked done" };

    subtask.done = true;
    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "subtask_marked_done",
      message: `Subtask ${subtaskId} has been marked as done.\n${progressTable}`,
      subtask: {
        id: subtask.id,
        title: subtask.title,
        description: subtask.description,
        done: subtask.done,
      },
      allSubtasksDone: task.subtasks.every(s => s.done),
    };
  }

  public async updateSubtask(
    requestId: string,
    taskId: string,
    subtaskId: string,
    updates: { title?: string; description?: string }
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    const task = req.tasks.find((t) => t.id === taskId);
    if (!task) return { status: "error", message: "Task not found" };

    const subtask = task.subtasks.find(s => s.id === subtaskId);
    if (!subtask) return { status: "error", message: "Subtask not found" };
    if (subtask.done)
      return { status: "error", message: "Cannot update completed subtask" };

    if (updates.title) subtask.title = updates.title;
    if (updates.description) subtask.description = updates.description;

    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "subtask_updated",
      message: `Subtask ${subtaskId} has been updated.\n${progressTable}`,
      subtask: {
        id: subtask.id,
        title: subtask.title,
        description: subtask.description,
        done: subtask.done,
      },
    };
  }

  public async deleteSubtask(
    requestId: string,
    taskId: string,
    subtaskId: string
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    const task = req.tasks.find((t) => t.id === taskId);
    if (!task) return { status: "error", message: "Task not found" };

    const subtaskIndex = task.subtasks.findIndex(s => s.id === subtaskId);
    if (subtaskIndex === -1) return { status: "error", message: "Subtask not found" };
    if (task.subtasks[subtaskIndex].done)
      return { status: "error", message: "Cannot delete completed subtask" };

    task.subtasks.splice(subtaskIndex, 1);
    await this.saveTasks();

    const progressTable = this.formatTaskProgressTable(requestId);
    return {
      status: "subtask_deleted",
      message: `Subtask ${subtaskId} has been deleted.\n${progressTable}`,
    };
  }

  /**
   * Add a note to a request
   */
  public async addNote(
    requestId: string,
    title: string,
    content: string
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    const now = new Date().toISOString();
    this.taskCounter += 1;

    const note: Note = {
      id: `note-${this.taskCounter}`,
      title,
      content,
      createdAt: now,
      updatedAt: now,
    };

    if (!req.notes) {
      req.notes = [];
    }

    req.notes.push(note);
    await this.saveTasks();

    return {
      status: "note_added",
      message: `Note "${title}" has been added to request ${requestId}.`,
      note,
    };
  }

  /**
   * Update an existing note
   */
  public async updateNote(
    requestId: string,
    noteId: string,
    updates: { title?: string; content?: string }
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    if (!req.notes) {
      return { status: "error", message: "No notes found for this request" };
    }

    const noteIndex = req.notes.findIndex(n => n.id === noteId);
    if (noteIndex === -1) return { status: "error", message: "Note not found" };

    const note = req.notes[noteIndex];

    if (updates.title) note.title = updates.title;
    if (updates.content) note.content = updates.content;
    note.updatedAt = new Date().toISOString();

    await this.saveTasks();

    return {
      status: "note_updated",
      message: `Note ${noteId} has been updated.`,
      note,
    };
  }

  /**
   * Delete a note
   */
  public async deleteNote(
    requestId: string,
    noteId: string
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    if (!req.notes) {
      return { status: "error", message: "No notes found for this request" };
    }

    const noteIndex = req.notes.findIndex(n => n.id === noteId);
    if (noteIndex === -1) return { status: "error", message: "Note not found" };

    req.notes.splice(noteIndex, 1);
    await this.saveTasks();

    return {
      status: "note_deleted",
      message: `Note ${noteId} has been deleted.`,
    };
  }

  /**
   * Add a dependency to a request or task
   */
  public async addDependency(
    requestId: string,
    dependency: Dependency,
    taskId?: string
  ) {
    await this.loadTasks();
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (!req) return { status: "error", message: "Request not found" };

    if (taskId) {
      // Add dependency to a specific task
      const task = req.tasks.find((t) => t.id === taskId);
      if (!task) return { status: "error", message: "Task not found" };

      if (!task.dependencies) {
        task.dependencies = [];
      }

      task.dependencies.push(dependency);
      await this.saveTasks();

      return {
        status: "dependency_added_to_task",
        message: `Dependency "${dependency.name}" has been added to task ${taskId}.`,
        dependency,
      };
    } else {
      // Add dependency to the request
      if (!req.dependencies) {
        req.dependencies = [];
      }

      req.dependencies.push(dependency);
      await this.saveTasks();

      return {
        status: "dependency_added_to_request",
        message: `Dependency "${dependency.name}" has been added to request ${requestId}.`,
        dependency,
      };
    }
  }
}

const server = new Server(
  {
    name: "taskflow-mcp",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const taskFlowServer = new TaskFlowServer();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    PLAN_TASK_TOOL,
    GET_NEXT_TASK_TOOL,
    MARK_TASK_DONE_TOOL,
    OPEN_TASK_DETAILS_TOOL,
    LIST_REQUESTS_TOOL,
    ADD_TASKS_TO_REQUEST_TOOL,
    UPDATE_TASK_TOOL,
    DELETE_TASK_TOOL,
    ADD_SUBTASKS_TOOL,
    MARK_SUBTASK_DONE_TOOL,
    UPDATE_SUBTASK_TOOL,
    DELETE_SUBTASK_TOOL,
    EXPORT_TASK_STATUS_TOOL,
    ADD_NOTE_TOOL,
    UPDATE_NOTE_TOOL,
    DELETE_NOTE_TOOL,
    ADD_DEPENDENCY_TOOL,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "plan_task": {
        const parsed = RequestPlanningSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { originalRequest, tasks, splitDetails } = parsed.data;
        const result = await taskFlowServer.requestPlanning(
          originalRequest,
          tasks,
          splitDetails
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "get_next_task": {
        const parsed = GetNextTaskSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const result = await taskFlowServer.getNextTask(
          parsed.data.requestId
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "mark_task_done": {
        const parsed = MarkTaskDoneSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId, completedDetails } = parsed.data;
        const result = await taskFlowServer.markTaskDone(
          requestId,
          taskId,
          completedDetails
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }


      case "open_task_details": {
        const parsed = OpenTaskDetailsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { taskId } = parsed.data;
        const result = await taskFlowServer.openTaskDetails(taskId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "list_requests": {
        const parsed = ListRequestsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const result = await taskFlowServer.listRequests();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "add_tasks_to_request": {
        const parsed = AddTasksToRequestSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, tasks } = parsed.data;
        const result = await taskFlowServer.addTasksToRequest(
          requestId,
          tasks
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "update_task": {
        const parsed = UpdateTaskSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId, title, description } = parsed.data;
        const result = await taskFlowServer.updateTask(requestId, taskId, {
          title,
          description,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "delete_task": {
        const parsed = DeleteTaskSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId } = parsed.data;
        const result = await taskFlowServer.deleteTask(requestId, taskId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "add_subtasks": {
        const parsed = AddSubtasksSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId, subtasks } = parsed.data;
        const result = await taskFlowServer.addSubtasks(requestId, taskId, subtasks);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "mark_subtask_done": {
        const parsed = MarkSubtaskDoneSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId, subtaskId } = parsed.data;
        const result = await taskFlowServer.markSubtaskDone(requestId, taskId, subtaskId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "update_subtask": {
        const parsed = UpdateSubtaskSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId, subtaskId, title, description } = parsed.data;
        const result = await taskFlowServer.updateSubtask(requestId, taskId, subtaskId, {
          title,
          description,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "delete_subtask": {
        const parsed = DeleteSubtaskSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId, subtaskId } = parsed.data;
        const result = await taskFlowServer.deleteSubtask(requestId, taskId, subtaskId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "export_task_status": {
        const parsed = ExportTaskStatusSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, outputPath, format } = parsed.data;
        await taskFlowServer.exportTaskStatus(requestId, outputPath, format);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "task_status_exported",
              message: `Task status has been exported to ${outputPath} in ${format} format.`,
              outputPath,
              format,
            }, null, 2)
          }],
        };
      }

      case "add_note": {
        const parsed = AddNoteSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, title, content } = parsed.data;
        const result = await taskFlowServer.addNote(requestId, title, content);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "update_note": {
        const parsed = UpdateNoteSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, noteId, title, content } = parsed.data;
        const result = await taskFlowServer.updateNote(requestId, noteId, { title, content });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "delete_note": {
        const parsed = DeleteNoteSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, noteId } = parsed.data;
        const result = await taskFlowServer.deleteNote(requestId, noteId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "add_dependency": {
        const parsed = AddDependencySchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }
        const { requestId, taskId, dependency } = parsed.data;
        const result = await taskFlowServer.addDependency(requestId, dependency, taskId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Task Manager MCP Server running. Saving tasks at: ${TASK_FILE_PATH}`
  );
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
