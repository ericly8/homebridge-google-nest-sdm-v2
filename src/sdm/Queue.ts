import {Logger} from "homebridge";

export class Queue {
    private readonly maxDelayMs: number = 60000;
    private queue: { fn: () => Promise<any>;
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        numRetries: number;
        queuedAt: number }[] = [];
    private timer: NodeJS.Timeout | null = null;
    private log: Logger;

    static #instance: Queue | null = null;

    constructor(log: Logger) {
        if (Queue.#instance) {
            throw new Error("Queue is a singleton class. Use Queue.getInstance() to get the instance.");
        }
        this.log = log;
    }

    static getInstance(log: Logger): Queue {
        if (!Queue.#instance) {
            Queue.#instance = new Queue(log);
        }
        return Queue.#instance;
    }

    enqueue<T>(fn: () => Promise<T>): Promise<T> {        
        // We hand back a promise, but we save its resolve/reject to be
        // triggered only when runQueue decides the job is truly done.
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ 
                fn: fn, 
                resolve: resolve, 
                reject: reject, 
                numRetries: 0,
                queuedAt: Date.now()
            });

            if (!this.timer) {
                this.timer = setTimeout(this.runQueue.bind(this), 0);
            }
        });
    }

    private async runQueue() {
        this.log.debug(`Command queue length: ${this.queue.length}`);

        if (this.queue.length === 0) {
            this.timer = null;
            return;
        }

        const command = this.queue.shift()!;
        let delay = 0;

        try {
            const result = await command.fn();
            command.resolve(result);            
        } catch (error: any) {
            const status = (error as {code?: number; response?: {status?: number}})?.code ??
                (error as {response?: {status?: number}})?.response?.status;
            
            this.log.debug(`Got error with status ${status}. Current retry attempts: ${command.numRetries}`);

            if (status === 429) {                
                // Put the same command back at the front of the queue
                this.queue.unshift(command);

                // Exponential backoff
                delay = Math.pow(2, ++command.numRetries) * 1000;
                if (delay > this.maxDelayMs) {
                    command.reject(error);
                    this.log.debug('Max delay exceeded. Rejecting command');
                } else {
                    // Add some jitter
                    delay += Math.floor(Math.random() * 1000);

                    this.log.info(`Throttling commands because of rate limit. Retrying in ${delay}ms`);
                }
            } else {
                // Fatal error: Reject the user's promise
                command.reject(error);
            }
        } finally {
            if (this.queue.length > 0) {
                this.log.debug(`Scheduling next command execution in ${delay}ms`);
                this.timer = setTimeout(this.runQueue.bind(this), delay);
            } else {
                this.log.debug('No more items in command queue');
                this.timer = null;
            }
        }
    }
}